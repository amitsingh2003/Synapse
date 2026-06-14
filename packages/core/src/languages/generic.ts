/**
 * Phase 21 — Universal Generic Language Adapter
 *
 * Supports ANY programming language with a tree-sitter WASM grammar by
 * mapping AST node types to our UAST symbol kinds. No per-language parser
 * code needed — just a declarative "language definition" describing which
 * node types produce symbols, edges, and imports.
 *
 * The existing premium adapters (TypeScript, Python, Go) take precedence
 * when registered; this adapter acts as the universal fallback that gives
 * instant support for C#, Java, C++, Rust, Ruby, Kotlin, Swift, PHP, etc.
 */
import Parser from 'web-tree-sitter';
import { createParser } from '../parser/runtime.js';
import type { ParseResult, ExtractedSymbol, ExtractedEdge, ImportBinding } from '../parser/extract.js';
import type { LanguageAdapter, ResolveCtx } from './types.js';
import type { SymbolKind } from '../db/queries.js';

type Node = Parser.SyntaxNode;

// ─── Language Definition Schema ──────────────────────────────────────────

export interface SymbolRule {
  /** Tree-sitter node type (e.g. 'function_declaration', 'class_declaration') */
  nodeType: string;
  /** Our UAST symbol kind */
  kind: SymbolKind;
  /** Field name for the identifier (default: 'name') */
  nameField?: string;
  /** If true, children with their own rules become parented to this symbol */
  isScope?: boolean;
  /**
   * If true, this node provides scope for children (they get parented to
   * the nearest ancestor that IS a real symbol) but does NOT emit a symbol
   * itself. Used for `impl` blocks in Rust.
   */
  scopeOnly?: boolean;
}

export interface ImportRule {
  /** Tree-sitter node type for import statements */
  nodeType: string;
  /** Field name for the module/path specifier */
  moduleField?: string;
  /** Child node type that holds the module specifier (alternative to field) */
  moduleChildType?: string;
  /** Field name for imported names list */
  namesField?: string;
}

export interface CallRule {
  /** Node type for call expressions */
  nodeType: string;
  /** Field name for the function/method being called */
  functionField?: string;
}

export interface GenericLanguageDef {
  /** Grammar id matching the WASM file: 'tree-sitter-{grammarId}.wasm' */
  grammarId: string;
  /** Display id for our system (stored in DB) */
  id: string;
  /** File extensions (with leading dot) */
  extensions: readonly string[];
  /** Vendor directories to skip */
  vendorDirs: readonly string[];
  /** Symbol extraction rules */
  symbols: readonly SymbolRule[];
  /** Import detection rules */
  imports: readonly ImportRule[];
  /** Call detection rules */
  calls: readonly CallRule[];
  /** Inheritance/extends detection node types → field for superclass */
  extends?: { nodeType: string; field: string }[];
  /**
   * Optional module resolver. When provided, the adapter is promoted to
   * Tier 1 and cross-file import edges are resolved precisely.
   * Receives the module specifier as extracted by the parser and must return
   * a repo-relative forward-slash path, or null if unresolvable.
   */
  resolveModule?: (spec: string, fromDir: string, ctx: ResolveCtx) => string | null;
}

// ─── Per-Language Definitions ────────────────────────────────────────────

export const JAVA_DEF: GenericLanguageDef = {
  grammarId: 'java',
  id: 'java',
  extensions: ['.java'],
  vendorDirs: ['target', 'build', '.gradle', 'out'],
  symbols: [
    { nodeType: 'class_declaration', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'interface_declaration', kind: 'interface', nameField: 'name', isScope: true },
    { nodeType: 'enum_declaration', kind: 'enum', nameField: 'name', isScope: true },
    { nodeType: 'method_declaration', kind: 'method', nameField: 'name' },
    { nodeType: 'constructor_declaration', kind: 'method', nameField: 'name' },
    { nodeType: 'field_declaration', kind: 'variable', nameField: 'declarator' },
    { nodeType: 'annotation_type_declaration', kind: 'type', nameField: 'name', isScope: true },
    { nodeType: 'record_declaration', kind: 'class', nameField: 'name', isScope: true },
  ],
  imports: [
    { nodeType: 'import_declaration' },
  ],
  calls: [
    { nodeType: 'method_invocation', functionField: 'name' },
    { nodeType: 'object_creation_expression', functionField: 'type' },
  ],
  extends: [
    { nodeType: 'superclass', field: 'type' },
    { nodeType: 'super_interfaces', field: 'type' },
  ],
  resolveModule: resolveJavaModule,
};

export const CSHARP_DEF: GenericLanguageDef = {
  grammarId: 'c_sharp',
  id: 'csharp',
  extensions: ['.cs'],
  vendorDirs: ['bin', 'obj', 'packages', '.vs'],
  symbols: [
    { nodeType: 'class_declaration', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'interface_declaration', kind: 'interface', nameField: 'name', isScope: true },
    { nodeType: 'struct_declaration', kind: 'struct', nameField: 'name', isScope: true },
    { nodeType: 'enum_declaration', kind: 'enum', nameField: 'name', isScope: true },
    { nodeType: 'method_declaration', kind: 'method', nameField: 'name' },
    { nodeType: 'constructor_declaration', kind: 'method', nameField: 'name' },
    { nodeType: 'property_declaration', kind: 'field', nameField: 'name' },
    { nodeType: 'field_declaration', kind: 'variable', nameField: 'declarator' },
    { nodeType: 'delegate_declaration', kind: 'type', nameField: 'name' },
    { nodeType: 'record_declaration', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'namespace_declaration', kind: 'namespace', nameField: 'name', isScope: true },
    { nodeType: 'event_declaration', kind: 'field', nameField: 'name' },
  ],
  imports: [
    { nodeType: 'using_directive' },
  ],
  calls: [
    { nodeType: 'invocation_expression', functionField: 'function' },
    { nodeType: 'object_creation_expression', functionField: 'type' },
  ],
  extends: [
    { nodeType: 'base_list', field: 'type' },
  ],
  resolveModule: resolveCSharpModule,
};

export const CPP_DEF: GenericLanguageDef = {
  grammarId: 'cpp',
  id: 'cpp',
  extensions: ['.cpp', '.cxx', '.cc', '.c', '.h', '.hpp', '.hxx', '.hh'],
  vendorDirs: ['build', 'cmake-build-debug', 'cmake-build-release', 'third_party', 'vendor'],
  symbols: [
    { nodeType: 'function_definition', kind: 'function', nameField: 'declarator', isScope: true },
    { nodeType: 'declaration', kind: 'function', nameField: 'declarator' },
    { nodeType: 'class_specifier', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'struct_specifier', kind: 'struct', nameField: 'name', isScope: true },
    { nodeType: 'enum_specifier', kind: 'enum', nameField: 'name', isScope: true },
    { nodeType: 'namespace_definition', kind: 'namespace', nameField: 'name', isScope: true },
    { nodeType: 'template_declaration', kind: 'type', nameField: 'name' },
    { nodeType: 'type_definition', kind: 'type', nameField: 'declarator' },
    { nodeType: 'field_declaration', kind: 'field', nameField: 'declarator' },
  ],
  imports: [
    { nodeType: 'preproc_include' },
  ],
  calls: [
    { nodeType: 'call_expression', functionField: 'function' },
  ],
  extends: [
    { nodeType: 'base_class_clause', field: 'type' },
  ],
};

export const RUST_DEF: GenericLanguageDef = {
  grammarId: 'rust',
  id: 'rust',
  extensions: ['.rs'],
  vendorDirs: ['target'],
  symbols: [
    { nodeType: 'function_item', kind: 'function', nameField: 'name', isScope: true },
    { nodeType: 'struct_item', kind: 'struct', nameField: 'name', isScope: true },
    { nodeType: 'enum_item', kind: 'enum', nameField: 'name', isScope: true },
    { nodeType: 'trait_item', kind: 'trait', nameField: 'name', isScope: true },
    { nodeType: 'impl_item', kind: 'namespace', nameField: 'type', isScope: true, scopeOnly: true },
    { nodeType: 'type_item', kind: 'type', nameField: 'name' },
    { nodeType: 'const_item', kind: 'constant', nameField: 'name' },
    { nodeType: 'static_item', kind: 'constant', nameField: 'name' },
    { nodeType: 'macro_definition', kind: 'macro', nameField: 'name' },
    { nodeType: 'mod_item', kind: 'module', nameField: 'name', isScope: true },
    { nodeType: 'function_signature_item', kind: 'function', nameField: 'name' },
  ],
  imports: [
    { nodeType: 'use_declaration' },
  ],
  calls: [
    { nodeType: 'call_expression', functionField: 'function' },
  ],
  extends: [],
};

export const RUBY_DEF: GenericLanguageDef = {
  grammarId: 'ruby',
  id: 'ruby',
  extensions: ['.rb', '.rake', '.gemspec'],
  vendorDirs: ['vendor', '.bundle'],
  symbols: [
    { nodeType: 'class', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'module', kind: 'module', nameField: 'name', isScope: true },
    { nodeType: 'method', kind: 'method', nameField: 'name' },
    { nodeType: 'singleton_method', kind: 'method', nameField: 'name' },
  ],
  imports: [],
  calls: [
    { nodeType: 'call', functionField: 'method' },
  ],
  extends: [],
};

export const KOTLIN_DEF: GenericLanguageDef = {
  grammarId: 'kotlin',
  id: 'kotlin',
  extensions: ['.kt', '.kts'],
  vendorDirs: ['build', '.gradle', 'out'],
  symbols: [
    { nodeType: 'class_declaration', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'object_declaration', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'function_declaration', kind: 'function', nameField: 'name' },
    { nodeType: 'property_declaration', kind: 'variable', nameField: 'name' },
    { nodeType: 'interface_declaration', kind: 'interface', nameField: 'name', isScope: true },
    { nodeType: 'enum_class_declaration', kind: 'enum', nameField: 'name', isScope: true },
    { nodeType: 'type_alias', kind: 'type', nameField: 'name' },
  ],
  imports: [
    { nodeType: 'import_header' },
  ],
  calls: [
    { nodeType: 'call_expression', functionField: 'name' },
  ],
  extends: [
    { nodeType: 'delegation_specifier', field: 'type' },
  ],
};

export const SWIFT_DEF: GenericLanguageDef = {
  grammarId: 'swift',
  id: 'swift',
  extensions: ['.swift'],
  vendorDirs: ['.build', 'Pods', 'Carthage'],
  symbols: [
    { nodeType: 'class_declaration', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'struct_declaration', kind: 'struct', nameField: 'name', isScope: true },
    { nodeType: 'protocol_declaration', kind: 'interface', nameField: 'name', isScope: true },
    { nodeType: 'enum_declaration', kind: 'enum', nameField: 'name', isScope: true },
    { nodeType: 'function_declaration', kind: 'function', nameField: 'name' },
    { nodeType: 'init_declaration', kind: 'method', nameField: 'name' },
    { nodeType: 'property_declaration', kind: 'variable', nameField: 'name' },
    { nodeType: 'typealias_declaration', kind: 'type', nameField: 'name' },
  ],
  imports: [
    { nodeType: 'import_declaration' },
  ],
  calls: [
    { nodeType: 'call_expression', functionField: 'function' },
  ],
  extends: [
    { nodeType: 'type_inheritance_clause', field: 'type' },
  ],
};

export const PHP_DEF: GenericLanguageDef = {
  grammarId: 'php',
  id: 'php',
  extensions: ['.php', '.phtml'],
  vendorDirs: ['vendor'],
  symbols: [
    { nodeType: 'class_declaration', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'interface_declaration', kind: 'interface', nameField: 'name', isScope: true },
    { nodeType: 'trait_declaration', kind: 'trait', nameField: 'name', isScope: true },
    { nodeType: 'enum_declaration', kind: 'enum', nameField: 'name', isScope: true },
    { nodeType: 'function_definition', kind: 'function', nameField: 'name' },
    { nodeType: 'method_declaration', kind: 'method', nameField: 'name' },
    { nodeType: 'property_declaration', kind: 'variable', nameField: 'name' },
    { nodeType: 'namespace_definition', kind: 'namespace', nameField: 'name', isScope: true },
  ],
  imports: [
    { nodeType: 'namespace_use_declaration' },
  ],
  calls: [
    { nodeType: 'function_call_expression', functionField: 'function' },
    { nodeType: 'member_call_expression', functionField: 'name' },
    { nodeType: 'scoped_call_expression', functionField: 'name' },
  ],
  extends: [
    { nodeType: 'base_clause', field: 'name' },
    { nodeType: 'class_interface_clause', field: 'name' },
  ],
};

export const DART_DEF: GenericLanguageDef = {
  grammarId: 'dart',
  id: 'dart',
  extensions: ['.dart'],
  vendorDirs: ['.dart_tool', 'build'],
  symbols: [
    { nodeType: 'class_definition', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'mixin_declaration', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'enum_declaration', kind: 'enum', nameField: 'name', isScope: true },
    { nodeType: 'function_signature', kind: 'function', nameField: 'name' },
    { nodeType: 'method_signature', kind: 'method', nameField: 'name' },
    { nodeType: 'getter_signature', kind: 'method', nameField: 'name' },
    { nodeType: 'setter_signature', kind: 'method', nameField: 'name' },
    { nodeType: 'type_alias', kind: 'type', nameField: 'name' },
  ],
  imports: [
    { nodeType: 'import_or_export' },
  ],
  calls: [
    { nodeType: 'function_expression_body', functionField: 'name' },
  ],
  extends: [
    { nodeType: 'superclass', field: 'type' },
    { nodeType: 'interfaces', field: 'type' },
  ],
};

export const SCALA_DEF: GenericLanguageDef = {
  grammarId: 'scala',
  id: 'scala',
  extensions: ['.scala', '.sc'],
  vendorDirs: ['target', '.bsp', '.metals', 'project/target'],
  symbols: [
    { nodeType: 'class_definition', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'object_definition', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'trait_definition', kind: 'trait', nameField: 'name', isScope: true },
    { nodeType: 'function_definition', kind: 'function', nameField: 'name' },
    { nodeType: 'val_definition', kind: 'variable', nameField: 'pattern' },
    { nodeType: 'var_definition', kind: 'variable', nameField: 'pattern' },
    { nodeType: 'type_definition', kind: 'type', nameField: 'name' },
  ],
  imports: [
    { nodeType: 'import_declaration' },
  ],
  calls: [
    { nodeType: 'call_expression', functionField: 'function' },
  ],
  extends: [
    { nodeType: 'extends_clause', field: 'type' },
  ],
};

export const ZIG_DEF: GenericLanguageDef = {
  grammarId: 'zig',
  id: 'zig',
  extensions: ['.zig'],
  vendorDirs: ['zig-cache', 'zig-out'],
  symbols: [
    { nodeType: 'function_declaration', kind: 'function', nameField: 'name', isScope: true },
    { nodeType: 'variable_declaration', kind: 'variable', nameField: 'name' },
    { nodeType: 'struct_declaration', kind: 'struct', nameField: 'name', isScope: true },
    { nodeType: 'enum_declaration', kind: 'enum', nameField: 'name', isScope: true },
    { nodeType: 'union_declaration', kind: 'struct', nameField: 'name', isScope: true },
  ],
  imports: [],
  calls: [
    { nodeType: 'call_expression', functionField: 'function' },
  ],
  extends: [],
};

export const LUA_DEF: GenericLanguageDef = {
  grammarId: 'lua',
  id: 'lua',
  extensions: ['.lua'],
  vendorDirs: [],
  symbols: [
    { nodeType: 'function_declaration', kind: 'function', nameField: 'name', isScope: true },
    { nodeType: 'local_function', kind: 'function', nameField: 'name', isScope: true },
    { nodeType: 'function_definition', kind: 'function', nameField: 'name', isScope: true },
  ],
  imports: [],
  calls: [
    { nodeType: 'function_call', functionField: 'name' },
  ],
  extends: [],
};

// ─── Phase 22.1 — Long-tail language definitions ─────────────────────────

export const BASH_DEF: GenericLanguageDef = {
  grammarId: 'bash',
  id: 'bash',
  extensions: ['.sh', '.bash', '.zsh'],
  vendorDirs: [],
  symbols: [
    { nodeType: 'function_definition', kind: 'function', nameField: 'name', isScope: true },
  ],
  imports: [
    { nodeType: 'command' }, // source / . commands captured as imports
  ],
  calls: [
    { nodeType: 'command', functionField: 'name' },
  ],
  extends: [],
};

export const ELIXIR_DEF: GenericLanguageDef = {
  grammarId: 'elixir',
  id: 'elixir',
  extensions: ['.ex', '.exs'],
  vendorDirs: ['_build', 'deps'],
  symbols: [
    { nodeType: 'call', kind: 'function', nameField: 'target' },
  ],
  imports: [],
  calls: [
    { nodeType: 'call', functionField: 'target' },
  ],
  extends: [],
};

export const ELM_DEF: GenericLanguageDef = {
  grammarId: 'elm',
  id: 'elm',
  extensions: ['.elm'],
  vendorDirs: ['elm-stuff'],
  symbols: [
    { nodeType: 'function_declaration_left', kind: 'function', nameField: 'name' },
    { nodeType: 'type_declaration', kind: 'type', nameField: 'name' },
    { nodeType: 'type_alias_declaration', kind: 'type', nameField: 'name' },
  ],
  imports: [
    { nodeType: 'import_clause' },
  ],
  calls: [],
  extends: [],
};

export const OCAML_DEF: GenericLanguageDef = {
  grammarId: 'ocaml',
  id: 'ocaml',
  extensions: ['.ml', '.mli'],
  vendorDirs: ['_build', '_opam'],
  symbols: [
    { nodeType: 'value_definition', kind: 'function', nameField: 'pattern' },
    { nodeType: 'let_binding', kind: 'function', nameField: 'pattern' },
    { nodeType: 'module_definition', kind: 'module', nameField: 'name', isScope: true },
    { nodeType: 'type_definition', kind: 'type', nameField: 'name' },
  ],
  imports: [
    { nodeType: 'open_module' },
  ],
  calls: [
    { nodeType: 'application_expression', functionField: 'function' },
  ],
  extends: [],
};

export const SOLIDITY_DEF: GenericLanguageDef = {
  grammarId: 'solidity',
  id: 'solidity',
  extensions: ['.sol'],
  vendorDirs: ['node_modules', 'artifacts', 'cache'],
  symbols: [
    { nodeType: 'contract_declaration', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'interface_declaration', kind: 'interface', nameField: 'name', isScope: true },
    { nodeType: 'library_declaration', kind: 'module', nameField: 'name', isScope: true },
    { nodeType: 'function_definition', kind: 'function', nameField: 'name' },
    { nodeType: 'constructor_definition', kind: 'method', nameField: 'name' },
    { nodeType: 'modifier_definition', kind: 'method', nameField: 'name' },
    { nodeType: 'event_definition', kind: 'field', nameField: 'name' },
    { nodeType: 'struct_declaration', kind: 'struct', nameField: 'name', isScope: true },
    { nodeType: 'enum_declaration', kind: 'enum', nameField: 'name', isScope: true },
  ],
  imports: [
    { nodeType: 'import_directive' },
  ],
  calls: [
    { nodeType: 'call_expression', functionField: 'function' },
  ],
  extends: [
    { nodeType: 'inheritance_specifier', field: 'ancestor' },
  ],
};

export const OBJC_DEF: GenericLanguageDef = {
  grammarId: 'objc',
  id: 'objc',
  extensions: ['.m', '.mm'],
  vendorDirs: ['build', 'DerivedData', 'Pods'],
  symbols: [
    { nodeType: 'class_interface', kind: 'interface', nameField: 'name', isScope: true },
    { nodeType: 'class_implementation', kind: 'class', nameField: 'name', isScope: true },
    { nodeType: 'protocol_declaration', kind: 'interface', nameField: 'name', isScope: true },
    { nodeType: 'method_definition', kind: 'method', nameField: 'selector' },
    { nodeType: 'function_definition', kind: 'function', nameField: 'declarator' },
  ],
  imports: [
    { nodeType: 'preproc_include' },
    { nodeType: 'preproc_import' },
  ],
  calls: [
    { nodeType: 'call_expression', functionField: 'function' },
    { nodeType: 'message_expression', functionField: 'selector' },
  ],
  extends: [],
};

export const VUE_DEF: GenericLanguageDef = {
  grammarId: 'vue',
  id: 'vue',
  extensions: ['.vue'],
  vendorDirs: ['node_modules', 'dist'],
  symbols: [
    { nodeType: 'component', kind: 'jsx_component', nameField: 'name', isScope: true },
    { nodeType: 'element', kind: 'jsx_component', nameField: 'name' },
  ],
  imports: [],
  calls: [],
  extends: [],
};

export const RESCRIPT_DEF: GenericLanguageDef = {
  grammarId: 'rescript',
  id: 'rescript',
  extensions: ['.res', '.resi'],
  vendorDirs: ['node_modules', 'lib'],
  symbols: [
    { nodeType: 'let_binding', kind: 'function', nameField: 'pattern' },
    { nodeType: 'module_declaration', kind: 'module', nameField: 'name', isScope: true },
    { nodeType: 'type_declaration', kind: 'type', nameField: 'name' },
  ],
  imports: [
    { nodeType: 'open_statement' },
  ],
  calls: [],
  extends: [],
};

// ─── Java module resolution ──────────────────────────────────────────────

/**
 * Common Maven / Gradle / Bazel source roots, in probe order.
 * The empty string '' means "try from repo root directly".
 */
const JAVA_SOURCE_ROOTS = [
  '',
  'src/main/java/',
  'src/test/java/',
  'src/java/',
  'src/',
  'app/src/main/java/',
  'app/src/test/java/',
];

/**
 * Resolve a Java import specifier to a repo-relative file path.
 *
 * Handles:
 *  - Exact class imports: `com.example.service.UserService` → `…/UserService.java`
 *  - Wildcard imports:    `com.example.service.*`           → first .java under package dir
 *  - Static imports:      `static com.example.Utils.METHOD` → `…/Utils.java`
 */
export function resolveJavaModule(
  spec: string,
  _fromDir: string,
  ctx: ResolveCtx,
): string | null {
  const isStatic = /^static\s+/.test(spec);
  const cleaned = spec.replace(/^static\s+/, '').trim();
  const isWildcard = cleaned.endsWith('.*');
  const dotPath = isWildcard ? cleaned.slice(0, -2) : cleaned;
  const slashPath = dotPath.replace(/\./g, '/');

  if (isWildcard) {
    // Return any .java file directly inside the package directory
    for (const root of JAVA_SOURCE_ROOTS) {
      const prefix = root ? `${root}${slashPath}/` : `${slashPath}/`;
      for (const key of ctx.filesByPath.keys()) {
        if (!key.endsWith('.java')) continue;
        if (!key.startsWith(prefix)) continue;
        // Must be directly in the package dir, not a sub-package
        if (!key.slice(prefix.length).includes('/')) return key;
      }
    }
    return null;
  }

  // Build list of slash paths to probe: for static imports also try dropping
  // the trailing method-name segment (e.g. `com/example/Utils/formatDate` → `com/example/Utils`)
  const candidates = [slashPath];
  if (isStatic) {
    const lastSlash = slashPath.lastIndexOf('/');
    if (lastSlash > 0) candidates.push(slashPath.slice(0, lastSlash));
  }

  for (const sp of candidates) {
    // Probe known source roots first (fast path)
    for (const root of JAVA_SOURCE_ROOTS) {
      const candidate = root ? `${root}${sp}.java` : `${sp}.java`;
      if (ctx.filesByPath.has(candidate)) return candidate;
    }

    // Fallback: suffix search for repos with non-standard layouts
    const suffix = `/${sp}.java`;
    for (const key of ctx.filesByPath.keys()) {
      if (key === `${sp}.java` || key.endsWith(suffix)) return key;
    }
  }

  return null;
}

// ─── C# module resolution ────────────────────────────────────────────────

/**
 * Common .NET project source roots, in probe order.
 */
const CSHARP_SOURCE_ROOTS = ['', 'src/', 'Source/', 'Src/'];

/**
 * Resolve a C# `using` directive to a repo-relative file path.
 *
 * Handles:
 *  - Namespace imports:    `using MyApp.Services`         → `…/Services.cs`
 *  - Class-level imports:  `using MyApp.Services.Email`   → `…/Email.cs`
 *  - Namespace directories:`using MyApp.Services`         → first .cs under `MyApp/Services/`
 *
 * C# doesn't enforce a 1:1 file/class mapping, so after the exact-file probe
 * we also accept any .cs file directly inside the matching namespace directory.
 */
export function resolveCSharpModule(
  spec: string,
  _fromDir: string,
  ctx: ResolveCtx,
): string | null {
  const slashPath = spec.trim().replace(/\./g, '/');

  // 1. Exact file probe: `MyApp/Services/Email.cs`
  for (const root of CSHARP_SOURCE_ROOTS) {
    const candidate = root ? `${root}${slashPath}.cs` : `${slashPath}.cs`;
    if (ctx.filesByPath.has(candidate)) return candidate;
  }

  // 2. Suffix search (non-standard layouts where the root isn't indexed)
  const suffix = `/${slashPath}.cs`;
  for (const key of ctx.filesByPath.keys()) {
    if (key === `${slashPath}.cs` || key.endsWith(suffix)) return key;
  }

  // 3. Namespace directory: any .cs file directly under `MyApp/Services/`
  for (const root of CSHARP_SOURCE_ROOTS) {
    const prefix = root ? `${root}${slashPath}/` : `${slashPath}/`;
    for (const key of ctx.filesByPath.keys()) {
      if (!key.endsWith('.cs')) continue;
      if (!key.startsWith(prefix)) continue;
      if (!key.slice(prefix.length).includes('/')) return key;
    }
  }

  // 4. Suffix-based directory search
  const dirSuffix = `/${slashPath}/`;
  for (const key of ctx.filesByPath.keys()) {
    if (!key.endsWith('.cs')) continue;
    const idx = key.indexOf(dirSuffix);
    if (idx === -1) continue;
    const rest = key.slice(idx + dirSuffix.length);
    if (!rest.includes('/')) return key;
  }

  return null;
}

// ─── All language definitions registry ───────────────────────────────────

export const ALL_GENERIC_LANGUAGES: GenericLanguageDef[] = [
  JAVA_DEF,
  CSHARP_DEF,
  CPP_DEF,
  RUST_DEF,
  RUBY_DEF,
  KOTLIN_DEF,
  SWIFT_DEF,
  PHP_DEF,
  DART_DEF,
  SCALA_DEF,
  ZIG_DEF,
  LUA_DEF,
  // Phase 22.1 — long-tail
  BASH_DEF,
  ELIXIR_DEF,
  ELM_DEF,
  OCAML_DEF,
  SOLIDITY_DEF,
  OBJC_DEF,
  VUE_DEF,
  RESCRIPT_DEF,
];

// ─── Generic Parser Engine ───────────────────────────────────────────────

/**
 * Extract the rightmost meaningful identifier from a node.
 * Handles: `foo`, `obj.method`, `pkg::func`, `self.field`, etc.
 */
function extractIdentifier(node: Node, source: string): string | null {
  if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'name') {
    return source.slice(node.startIndex, node.endIndex);
  }
  // For qualified names like `a.b.c`, `a::b::c`, take the last component
  if (
    node.type === 'field_expression' ||
    node.type === 'member_expression' ||
    node.type === 'scoped_identifier' ||
    node.type === 'qualified_identifier' ||
    node.type === 'attribute' ||
    node.type === 'selector_expression'
  ) {
    const field =
      node.childForFieldName('field') ??
      node.childForFieldName('name') ??
      node.lastChild;
    if (field) return extractIdentifier(field, source);
  }
  // Variable declarator → grab the name
  if (node.type === 'variable_declarator' || node.type === 'init_declarator') {
    const nameChild = node.childForFieldName('name') ?? node.firstChild;
    if (nameChild) return extractIdentifier(nameChild, source);
  }
  // Function declarator (C/C++) → grab the declarator recursively
  if (node.type === 'function_declarator') {
    const decl = node.childForFieldName('declarator');
    if (decl) return extractIdentifier(decl, source);
  }
  // Pointer declarator (C/C++)
  if (node.type === 'pointer_declarator' || node.type === 'reference_declarator') {
    const decl = node.childForFieldName('declarator') ?? node.lastChild;
    if (decl) return extractIdentifier(decl, source);
  }
  // Fall back: try text of the node if it's short enough (likely a simple identifier)
  const text = source.slice(node.startIndex, node.endIndex).trim();
  if (text.length > 0 && text.length <= 60 && /^[a-zA-Z_]\w*$/.test(text)) {
    return text;
  }
  return null;
}

/**
 * Extract a module specifier string from an import-like node.
 * Handles string literals, identifiers, scoped names, etc.
 */
function extractModuleSpecifier(node: Node, source: string): string | null {
  // Look for string_literal children first
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (
      child.type === 'string_literal' ||
      child.type === 'string' ||
      child.type === 'system_lib_string' ||
      child.type === 'interpreted_string_literal'
    ) {
      const raw = source.slice(child.startIndex, child.endIndex);
      return raw.replace(/^["'<]|["'>]$/g, '');
    }
  }
  // For languages that use identifiers as module paths (Java, C#, Kotlin)
  const scopedChild = findFirstOfType(node, [
    'scoped_identifier', 'qualified_name', 'identifier',
    'name', 'scoped_type_identifier', 'qualified_identifier',
  ]);
  if (scopedChild) {
    return source.slice(scopedChild.startIndex, scopedChild.endIndex).trim();
  }
  // Fallback: full text minus keywords
  const text = source.slice(node.startIndex, node.endIndex).trim();
  const cleaned = text
    .replace(/^(import|using|require|use|include|from)\s+/g, '')
    .replace(/;?\s*$/, '')
    .replace(/^static\s+/, '')
    .trim();
  return cleaned || null;
}

function findFirstOfType(node: Node, types: string[]): Node | null {
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (types.includes(n.type)) return n;
    for (let i = n.childCount - 1; i >= 0; i--) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return null;
}

/**
 * Core parsing engine. Takes a GenericLanguageDef and produces a parse function
 * compatible with the LanguageAdapter interface.
 */
export async function genericParse(
  source: string,
  _filePath: string,
  def: GenericLanguageDef,
): Promise<ParseResult> {
  // Strip UTF-16 BOM (FF FE / FE FF) that Windows tooling sometimes writes.
  // Node reads these files as garbled UTF-8; stripping the BOM char lets the
  // grammar at least attempt to parse the (still mangled) content gracefully.
  const cleanSource = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;

  const parser = await createParser(def.grammarId);
  const tree = parser.parse(cleanSource);
  if (!tree) throw new Error(`tree-sitter returned null for ${def.id} source`);

  const symbols: ExtractedSymbol[] = [];
  const edges: ExtractedEdge[] = [];
  const imports: ImportBinding[] = [];

  // Build lookup sets for fast type checking
  const symbolRules = new Map<string, SymbolRule>();
  for (const rule of def.symbols) {
    symbolRules.set(rule.nodeType, rule);
  }
  const importTypes = new Set(def.imports.map((r) => r.nodeType));
  const callRules = new Map<string, CallRule>();
  for (const rule of def.calls) {
    callRules.set(rule.nodeType, rule);
  }

  // Iterative DFS walk
  const stack: { node: Node; parent: number | null }[] = [{ node: tree.rootNode, parent: null }];

  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    let childParent = parent;

    // 1. Check symbol rules
    const symRule = symbolRules.get(node.type);
    if (symRule) {
      if (symRule.scopeOnly) {
        // Scope-only: emit a synthetic scope name that won't collide.
        // Used for Rust `impl` blocks — provides method grouping without
        // creating a real queryable symbol.
        const nameField = symRule.nameField ?? 'name';
        const nameNode = node.childForFieldName(nameField);
        const rawName = nameNode ? extractIdentifier(nameNode, source) : null;
        if (rawName) {
          // Emit a synthetic symbol with a dedup suffix to avoid scip_id collision
          const localIndex = symbols.length;
          symbols.push({
            localIndex,
            parentLocalIndex: parent,
            name: `${rawName}$impl${node.startPosition.row}`,
            kind: symRule.kind,
            start_line: node.startPosition.row + 1,
            end_line: node.endPosition.row + 1,
            start_col: node.startPosition.column,
            end_col: node.endPosition.column,
            signature: firstLine(source, node),
            doc: null,
          });
          childParent = localIndex;
        }
      } else {
        const nameField = symRule.nameField ?? 'name';
        const nameNode = node.childForFieldName(nameField);
        const name = nameNode
          ? extractIdentifier(nameNode, source)
          : null;
        if (name && name.length > 0) {
          const localIndex = symbols.length;
          symbols.push({
            localIndex,
            parentLocalIndex: parent,
            name,
            kind: symRule.kind,
            start_line: node.startPosition.row + 1,
            end_line: node.endPosition.row + 1,
            start_col: node.startPosition.column,
            end_col: node.endPosition.column,
            signature: firstLine(source, node),
            doc: extractDoc(node, source),
          });
          if (symRule.isScope) {
            childParent = localIndex;
          }
        }
      }
    }

    // 2. Check import rules
    if (importTypes.has(node.type)) {
      const moduleSpec = extractModuleSpecifier(node, source);
      if (moduleSpec) {
        imports.push({
          localName: moduleSpec.split(/[./\\:]/).pop() ?? moduleSpec,
          importedName: moduleSpec,
          moduleSpecifier: moduleSpec,
          kind: 'value',
          line: node.startPosition.row + 1,
          col: node.startPosition.column,
        });
        edges.push({
          sourceLocalIndex: parent,
          target_name: moduleSpec,
          kind: 'IMPORTS',
          line: node.startPosition.row + 1,
          col: node.startPosition.column,
        });
      }
    }

    // 3. Check call rules
    const callRule = callRules.get(node.type);
    if (callRule) {
      const fnField = callRule.functionField ?? 'function';
      const fnNode = node.childForFieldName(fnField);
      if (fnNode) {
        const callee = extractIdentifier(fnNode, source);
        if (callee) {
          edges.push({
            sourceLocalIndex: parent,
            target_name: callee,
            kind: 'CALLS',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
          });
        }
      }
    }

    // Push children in reverse for source-order visitation
    for (let i = node.childCount - 1; i >= 0; i--) {
      const c = node.child(i);
      if (c) stack.push({ node: c, parent: childParent });
    }
  }

  return { language: def.id, symbols, edges, imports };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function firstLine(source: string, node: Node): string {
  const slice = source.slice(node.startIndex, node.endIndex);
  const line = slice.split('\n', 1)[0] ?? '';
  return line.trim().slice(0, 200);
}

/**
 * Extract documentation comment immediately preceding a node.
 * Handles // comments, /* comments, /// doc comments, /** javadoc */
function extractDoc(node: Node, source: string): string | null {
  const prev = node.previousNamedSibling;
  if (!prev) return null;
  if (prev.type === 'comment' || prev.type === 'line_comment' || prev.type === 'block_comment') {
    const text = source.slice(prev.startIndex, prev.endIndex);
    // Strip comment delimiters
    const cleaned = text
      .replace(/^\/\*\*?\s*|\s*\*\/$/g, '')
      .replace(/^\/\/\/?\s?/gm, '')
      .replace(/^\s*\*\s?/gm, '')
      .trim();
    return cleaned.length > 0 ? cleaned.slice(0, 500) : null;
  }
  return null;
}

// ─── Adapter Factory ─────────────────────────────────────────────────────

/**
 * Create a LanguageAdapter from a GenericLanguageDef. The adapter uses the
 * universal generic parser with language-specific node type mappings.
 */
export function createGenericAdapter(def: GenericLanguageDef): LanguageAdapter {
  return {
    id: def.id,
    extensions: def.extensions,
    vendorDirs: def.vendorDirs,
    resolveExts: [...def.extensions],
    indexFiles: [],

    async loadGrammar(_filePath: string) {
      const { loadLanguage } = await import('../parser/runtime.js');
      return loadLanguage(def.grammarId);
    },

    async parse(source: string, _filePath: string): Promise<ParseResult> {
      return genericParse(source, _filePath, def);
    },

    // Wire in language-specific module resolution when the def provides it.
    // Absent a resolver, cross-file resolution falls back to name-based
    // matching in the Phase 13 resolver.
    ...(def.resolveModule ? { resolveModule: def.resolveModule } : {}),
  };
}
