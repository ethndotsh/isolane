//! TypeScript, JSX, and `define` for a program's modules, with oxc, in the
//! worker: parse, check, transform, print, and a source map back to the
//! file. A file that needs none of them is compiled as it is.
//!
//! Results are kept per worker (a tenant's), keyed by a hash of the
//! options, the path, and the source, so a program's instances transform
//! each file once. The cache is bounded and dropped whole when full.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use oxc_allocator::Allocator;
use oxc_ast::ast::{Declaration, Program, Statement, TSNamespaceDeclarationBody};
use oxc_ast_visit::{walk, Visit};
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_diagnostics::OxcDiagnostic;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{SourceType, Span};
use oxc_transformer::{
    DecoratorOptions, HelperLoaderMode, HelperLoaderOptions, JsxOptions, JsxRuntime,
    TransformOptions, Transformer,
};
use oxc_transformer_plugins::{ReplaceGlobalDefines, ReplaceGlobalDefinesConfig};
use sha2::{Digest, Sha256};

use super::source_map::LineMap;
use crate::proto::{self, ModuleOptions, TsMode};

/// Where the transform's helpers (legacy decorators') are imported from:
/// `isolane:runtime/helpers/<name>`, built into the worker.
pub(crate) const HELPERS: &str = "isolane:runtime";

/// Most bytes of transformed code the cache keeps.
const CACHE_BYTES: usize = 64 << 20;

/// A transformed module.
pub(crate) struct Output {
    pub code: String,
    pub map: Arc<LineMap>,
}

/// Why a file didn't transform: oxc's message, and where (1-based).
pub(crate) struct Problem {
    pub message: String,
    pub line: u32,
    pub column: u32,
    pub end_column: u32,
}

/// What a program's files are transformed with.
pub(crate) struct Transforms {
    options: TransformOptions,
    strip_only: bool,
    defines: Option<ReplaceGlobalDefinesConfig>,
    /// The options, for cache keys.
    fingerprint: String,
}

impl Transforms {
    pub(crate) fn new(options: &ModuleOptions) -> Result<Self, String> {
        let mut transform = TransformOptions::default();
        let transform_mode = options.ts.mode == TsMode::Transform;
        transform.decorator = DecoratorOptions {
            legacy: transform_mode && options.ts.decorators,
            emit_decorator_metadata: transform_mode && options.ts.emit_decorator_metadata,
            ..DecoratorOptions::default()
        };
        let jsx = &options.jsx;
        transform.jsx = JsxOptions {
            runtime: match jsx.runtime {
                proto::JsxRuntime::Automatic => JsxRuntime::Automatic,
                proto::JsxRuntime::Classic => JsxRuntime::Classic,
            },
            development: jsx.development,
            import_source: jsx.import_source.clone(),
            pragma: jsx.factory.clone(),
            pragma_frag: jsx.fragment.clone(),
            ..JsxOptions::default()
        };
        transform.jsx.conform();
        if let Some(factory) = &jsx.factory {
            transform.typescript.jsx_pragma = factory.clone().into();
        }
        if let Some(fragment) = &jsx.fragment {
            transform.typescript.jsx_pragma_frag = fragment.clone().into();
        }
        transform.helper_loader = HelperLoaderOptions {
            module_name: HELPERS.into(),
            mode: HelperLoaderMode::Runtime,
        };
        let defines = if options.define.is_empty() {
            None
        } else {
            let config = ReplaceGlobalDefinesConfig::new(&options.define).map_err(|problems| {
                let first = problems.into_iter().next().map(|d| d.message.to_string());
                format!("define: {}", first.unwrap_or_else(|| "invalid".into()))
            })?;
            Some(config)
        };
        let fingerprint = serde_json::to_string(&(&options.ts, &options.jsx, &options.define))
            .unwrap_or_default();
        Ok(Self {
            options: transform,
            strip_only: !transform_mode,
            defines,
            fingerprint,
        })
    }

    /// Whether `path` is compiled from a transform: TypeScript, JSX, or any
    /// file when there are defines.
    pub(crate) fn applies(&self, path: &str) -> bool {
        self.defines.is_some() || source_type(path).is_some_and(|t| t.is_typescript() || t.is_jsx())
    }

    /// The options, as the caches key on them.
    pub(crate) fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// `source` (whose SHA-256 is `source_hash`) transformed, from the
    /// cache if this worker did it before.
    pub(crate) fn run(
        &self,
        path: &str,
        source: &str,
        source_hash: &[u8; 32],
    ) -> Result<Arc<Output>, Problem> {
        let mut hash = Sha256::new();
        for part in [
            self.fingerprint.as_bytes(),
            path.as_bytes(),
            source_hash.as_slice(),
        ] {
            hash.update((part.len() as u64).to_le_bytes());
            hash.update(part);
        }
        let key: [u8; 32] = hash.finalize().into();
        if let Some(hit) = cache().get(&key) {
            return Ok(hit);
        }
        let output = Arc::new(self.transform(path, source)?);
        cache().put(key, Arc::clone(&output));
        Ok(output)
    }

    fn transform(&self, path: &str, source: &str) -> Result<Output, Problem> {
        let source_type = source_type(path).unwrap_or_else(SourceType::mjs);
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, source, source_type).parse();
        if let Some(problem) = parsed.diagnostics.into_iter().next() {
            return Err(problem_at(source, &problem));
        }
        let mut program = parsed.program;
        if self.strip_only && source_type.is_typescript() {
            let mut check = Erasable(None);
            check.visit_program(&program);
            if let Some((span, what)) = check.0 {
                return Err(at_span(
                    source,
                    span,
                    format!("{what} is not erasable TypeScript: it has runtime behaviour, which type stripping can't keep. Load the program with ts: {{ mode: 'transform' }} to compile it"),
                ));
            }
        }
        let semantic = SemanticBuilder::new().build(&program);
        if let Some(problem) = semantic.diagnostics.into_iter().next() {
            return Err(problem_at(source, &problem));
        }
        let scoping = semantic.semantic.into_scoping();
        let transformed = Transformer::new(&allocator, Path::new(path), &self.options)
            .build_with_scoping(scoping, &mut program);
        if let Some(problem) = transformed.diagnostics.into_iter().next() {
            return Err(problem_at(source, &problem));
        }
        if let Some(config) = &self.defines {
            let _replaced = ReplaceGlobalDefines::new(&allocator, config.clone())
                .build(transformed.scoping, &mut program);
        }
        let options = CodegenOptions {
            source_map_path: Some(path.into()),
            ..CodegenOptions::default()
        };
        let printed = Codegen::new().with_options(options).build(&program);
        let map = printed
            .map
            .map(|map| Arc::new(LineMap::from_transform(&map, path)))
            .ok_or_else(|| at_span(source, Span::default(), "no source map".into()))?;
        Ok(Output {
            code: printed.code,
            map,
        })
    }
}

/// How oxc parses `path`, by its extension; None for anything but
/// JavaScript, TypeScript, and JSX.
fn source_type(path: &str) -> Option<SourceType> {
    let extension = path.rsplit_once('.').map(|(_, e)| e)?;
    let source_type = match extension {
        "js" | "mjs" => SourceType::mjs(),
        "jsx" => SourceType::jsx(),
        "ts" | "mts" => SourceType::ts(),
        "tsx" => SourceType::tsx(),
        _ => return None,
    };
    Some(source_type.with_module(true))
}

fn problem_at(source: &str, problem: &OxcDiagnostic) -> Problem {
    let span = problem
        .labels
        .first()
        .map(|label| Span::sized(label.offset(), label.len()))
        .unwrap_or_default();
    let mut message = problem.message.to_string();
    if let Some(help) = &problem.help {
        message = format!("{message} ({help})");
    }
    at_span(source, span, message)
}

/// `message` at `span` of `source`, as a line and (UTF-16) columns.
fn at_span(source: &str, span: Span, message: String) -> Problem {
    let start = (span.start as usize).min(source.len());
    let before = &source[..start];
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let line = before.matches('\n').count() as u32 + 1;
    let column = source[line_start..start].encode_utf16().count() as u32 + 1;
    let end = (span.end as usize).clamp(start, source.len());
    let line_end = source[start..]
        .find('\n')
        .map_or(source.len(), |i| start + i);
    let width = source[start..end.min(line_end)].encode_utf16().count() as u32;
    Problem {
        message,
        line,
        column,
        end_column: column + width.max(1),
    }
}

/// The first TypeScript syntax with runtime meaning, which stripping types
/// alone can't keep: `enum`, a namespace with values, a parameter
/// property, `import x = require()`, `export =`.
struct Erasable(Option<(Span, &'static str)>);

impl Erasable {
    fn found(&mut self, span: Span, what: &'static str) {
        if self.0.is_none() {
            self.0 = Some((span, what));
        }
    }
}

impl<'a> Visit<'a> for Erasable {
    fn visit_ts_enum_declaration(&mut self, it: &oxc_ast::ast::TSEnumDeclaration<'a>) {
        if !it.declare {
            self.found(it.span, "An enum");
        }
    }

    fn visit_ts_namespace_declaration(&mut self, it: &oxc_ast::ast::TSNamespaceDeclaration<'a>) {
        if !it.declare && namespace_has_values(&it.body) {
            self.found(it.span, "A namespace with values");
        }
    }

    fn visit_formal_parameter(&mut self, it: &oxc_ast::ast::FormalParameter<'a>) {
        if it.accessibility.is_some() || it.readonly || it.r#override {
            self.found(it.span, "A parameter property");
        }
        walk::walk_formal_parameter(self, it);
    }

    fn visit_ts_import_equals_declaration(
        &mut self,
        it: &oxc_ast::ast::TSImportEqualsDeclaration<'a>,
    ) {
        if !it.import_kind.is_type() {
            self.found(it.span, "`import =`");
        }
    }

    fn visit_ts_export_assignment(&mut self, it: &oxc_ast::ast::TSExportAssignment<'a>) {
        self.found(it.span, "`export =`");
    }

    fn visit_program(&mut self, it: &Program<'a>) {
        walk::walk_program(self, it);
    }
}

/// Whether a namespace declares anything but types (so it has an object
/// at runtime).
fn namespace_has_values(body: &TSNamespaceDeclarationBody) -> bool {
    match body {
        TSNamespaceDeclarationBody::TSNamespaceDeclaration(inner) => {
            !inner.declare && namespace_has_values(&inner.body)
        }
        TSNamespaceDeclarationBody::TSModuleBlock(block) => block.body.iter().any(has_value),
    }
}

fn has_value(statement: &Statement) -> bool {
    match statement {
        Statement::ExportDeclaration(export) => declaration_has_value(&export.declaration),
        Statement::ExportNamedDeclaration(export) => export.export_kind.is_value(),
        Statement::EmptyStatement(_) => false,
        other => other.as_declaration().is_none_or(declaration_has_value),
    }
}

fn declaration_has_value(declaration: &Declaration) -> bool {
    match declaration {
        Declaration::TSInterfaceDeclaration(_) | Declaration::TSTypeAliasDeclaration(_) => false,
        Declaration::TSNamespaceDeclaration(inner) => {
            !inner.declare && namespace_has_values(&inner.body)
        }
        Declaration::TSEnumDeclaration(enumeration) => !enumeration.declare,
        Declaration::VariableDeclaration(_)
        | Declaration::FunctionDeclaration(_)
        | Declaration::ClassDeclaration(_) => !declaration.is_typescript_syntax(),
        _ => true,
    }
}

/// The worker's transform cache.
#[derive(Default)]
struct Cache {
    entries: HashMap<[u8; 32], Arc<Output>>,
    bytes: usize,
}

struct Shared(Mutex<Cache>);

impl Shared {
    fn get(&self, key: &[u8; 32]) -> Option<Arc<Output>> {
        self.0.lock().ok()?.entries.get(key).cloned()
    }

    fn put(&self, key: [u8; 32], output: Arc<Output>) {
        let Ok(mut cache) = self.0.lock() else {
            return;
        };
        let size = output.code.len() + output.map.byte_size();
        if size > CACHE_BYTES {
            return;
        }
        if cache.bytes + size > CACHE_BYTES {
            *cache = Cache::default();
        }
        cache.bytes += size;
        cache.entries.insert(key, output);
    }
}

fn cache() -> &'static Shared {
    static CACHE: std::sync::OnceLock<Shared> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Shared(Mutex::new(Cache::default())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(source: &str) -> Result<String, String> {
        let transforms = Transforms::new(&ModuleOptions::default())?;
        transforms
            .transform("a.ts", source)
            .map(|o| o.code)
            .map_err(|p| format!("{}:{}: {}", p.line, p.column, p.message))
    }

    #[test]
    fn strips_types() {
        let out = strip("const x: number = 1;\nexport function f(a: string): void {}\n");
        assert!(
            out.as_deref().is_ok_and(|c| !c.contains("number")),
            "{out:?}"
        );
    }

    #[test]
    fn refuses_enums_when_stripping() {
        let out = strip("let a = 1;\nenum E { A }\n");
        assert!(
            out.as_ref().is_err_and(|e| e.starts_with("2:1: An enum")),
            "{out:?}"
        );
        assert!(strip("declare enum E { A }\nnamespace N { export type T = 1 }\n").is_ok());
        assert!(strip("namespace N { export const x = 1 }").is_err());
        assert!(strip("class C { constructor(private x: number) {} }").is_err());
    }

    #[test]
    fn reports_syntax_errors_where_they_are() {
        let out = strip("let a = 1;\nlet b = ;\n");
        assert!(out.as_ref().is_err_and(|e| e.starts_with("2:9")), "{out:?}");
    }
}
