import { TSDocParser } from '@microsoft/tsdoc'
import createDebug from 'debug'
import * as path from 'path'
import * as tsm from 'ts-morph'
import {
  getNameOrThrow,
  getSourceFileModulePath,
  getSourceFileOrThrow,
  hasAlias,
  isPrimitive,
  isTypeLevelNode,
} from './lib/ts-helpers'
import { Index, Thunk } from './lib/utils'
import { dumpNode, dumpType, renderTSDocNode } from './utils'

registerDumper((...args) => {
  if (args[0] instanceof tsm.Node) {
    dumpNode(args[0])
    return true
  }
  return false
})

registerDumper((...args) => {
  if (args[0] instanceof tsm.Type) {
    dumpType(args[0])
    return true
  }
  return false
})

const debug = createDebug('tydoc:doc')

export interface Settings {
  projectDir: string
  /**
   * Absolute path to the source root. This should match the path that rootDir
   * resolves to from the project's tsconfig.json.
   */
  sourceDir: string
  sourceMainModulePath: string
  sourceModuleToPackagePathMappings?: Record<string, string>
}

/**
 * Create a new set of docs.
 */
export class Manager {
  constructor(public settings: Settings) {
    this.settings.sourceModuleToPackagePathMappings = Object.fromEntries(
      Object.entries(this.settings.sourceModuleToPackagePathMappings ?? {}).map(([k, v]) => {
        return [path.normalize(k), path.normalize(path.join('/', v))]
      })
    )
  }

  EDD: Package = {
    modules: [],
    typeIndex: {},
  }

  tsdocParser: TSDocParser = new TSDocParser()

  isIndexable(t: tsm.Type): boolean {
    if (t.isLiteral()) return false
    if (isPrimitive(t)) return false
    // something without a symbol must be inline since it means it is nameless
    if (!t.getSymbol() && !t.getAliasSymbol()) return false
    // an object with no alias means it must be inline
    // note that interfaces are considered objects so we filter these out
    if (!t.isInterface() && !hasAlias(t) && t.isObject()) return false
    return true
  }

  isIndexed(name: string): boolean {
    return this.EDD.typeIndex[name] !== undefined
  }

  getFromIndex(name: string): Node {
    const node = this.EDD.typeIndex[name]
    if (!node) throw new Error(`Could not find "${name}" in the EDD Type Index.`)
    return node
  }

  getFQTN(t: tsm.Type): string {
    return getFQTNFromType(this.settings.sourceDir, t)
  }

  indexTypeAliasNode(n: tsm.TypeAliasDeclaration, doc: Thunk<Node>): Node {
    const fqtn = getFQTNFromTypeAliasNode(this.settings.sourceDir, n)
    this.EDD.typeIndex[fqtn] = {} as any
    const result = doc() as IndexableNode
    this.EDD.typeIndex[fqtn] = result
    return typeIndexRef(fqtn)
  }

  indexTypeIfApplicable(t: tsm.Type, doc: Thunk<Node>) {
    if (this.isIndexable(t)) {
      const fqtn = getFQTNFromType(this.settings.sourceDir, t)
      if (!this.isIndexed(fqtn)) {
        // register then hydrate, this prevents infinite loops
        debug('provisioning entry in type index: %s', fqtn)
        this.EDD.typeIndex[fqtn] = {} as any
        const result = doc() as IndexableNode
        debug('hydrating entry in type index: %s', fqtn)
        this.EDD.typeIndex[fqtn] = result
      }
      return typeIndexRef(fqtn)
    }
    return doc()
  }

  isMainModule(sf: tsm.SourceFile): boolean {
    return this.settings.sourceMainModulePath === getSourceFileModulePath(sf)
  }

  getImportFromPath(sf: tsm.SourceFile): string {
    // handle root case
    if (this.isMainModule(sf)) {
      return '/'
    }

    const modulePath = getSourceFileModulePath(sf)

    // handle mapped non-root module case
    const srcRelModulePath = path.relative(this.settings.sourceDir, modulePath)
    const packageMapping = this.settings.sourceModuleToPackagePathMappings?.[srcRelModulePath]
    if (packageMapping) {
      debug('getting module path (%s) from settings mappings', packageMapping)
      return packageMapping
    }

    // handle non-root module case
    return path.join('/', path.relative(this.settings.projectDir, modulePath))
  }
}

// // todo move to test suite
// getMainModule({
//   outDir: './dist',
//   srcDir: './src',
//   packageMainEntrypoint: './main.js',
// }) //?
// getMainModule({
//   outDir: 'dist',
//   srcDir: 'src',
//   packageMainEntrypoint: 'main.js',
// }) //?
// getMainModule({
//   outDir: 'dist',
//   srcDir: 'src',
//   packageMainEntrypoint: 'main',
// }) //?
// getMainModule({
//   outDir: '/projects/foo/dist',
//   srcDir: '/projects/foo/src',
//   packageMainEntrypoint: '/projects/foo/main.js',
// }) //?
// getMainModule({
//   outDir: '/projects/foo/dist',
//   srcDir: '/projects/foo/src',
//   packageMainEntrypoint: '/projects/foo/dist/index.js',
// }) //?
// getMainModule({
//   outDir: '/projects/foo/dist',
//   srcDir: '/projects/foo/src',
//   packageMainEntrypoint: '/projects/foo/dist/index.js',
// }) //?

export function getFQTNFromTypeAliasNode(sourceRoot: string, n: tsm.TypeAliasDeclaration): string {
  const typePath = getPathFromSourceRoot(sourceRoot, n.getSourceFile())
  const fqtn = formatFQTN(typePath, n.getName())
  return fqtn
}

export function getFQTNFromType(sourceRoot: string, t: tsm.Type): string {
  let typeName = getNameOrThrow(t)
  let sourceFile = getSourceFileOrThrow(t)
  const typePath = getPathFromSourceRoot(sourceRoot, sourceFile)
  const fqtn = formatFQTN(typePath, typeName)
  return fqtn
}

function formatFQTN(typePath: string, typeName: string): string {
  return `(${typePath}).${typeName}`
}

function getPathFromSourceRoot(sourceRoot: string, sourceFile: tsm.SourceFile): string {
  const filePath = sourceFile.getFilePath()
  const fileDirPath = path.dirname(filePath)
  //todo file path to module path helper
  const modulePath = path.join(fileDirPath, sourceFile.getBaseNameWithoutExtension())
  return path.relative(sourceRoot, modulePath)
}

export type Node =
  | DocTypeUnion
  | DocTypePrimitive
  | DocTypeLiteral
  | Alias
  | Interface
  | DocTypeCallable
  | DocTypeArray
  | DocTypeObject
  | IndexRef
  | Unsupported
  | DocTypeIntersection
  | GenericInstance
  | StandardLibrary

export type IndexableNode = Alias | Interface

export type TypeNode =
  | DocTypeUnion
  | DocTypeIntersection
  | DocTypePrimitive
  | DocTypeLiteral
  | Alias
  | Interface
  | DocTypeCallable
  | DocTypeArray
  | DocTypeObject
  | StandardLibrary

/**
 * Any type that can be nameless.
 *
 * For example in the following the "bar" param type is nameless.
 *
 * ```ts
 * function foo(x: { bar: string, qux: boolean }): void {}
 * ```
 */
export type InlinableType =
  | DocTypeUnion
  | DocTypePrimitive
  | DocTypeLiteral
  | DocTypeCallable // const a: {():void} = ...
  | DocTypeArray
  | DocTypeObject
  | DocTypeIntersection
  | GenericInstance

export type InlineTypeOrIndexRef = InlinableType | IndexRef

//
// Node Features
//

export type TSDocFrag = {
  /**
   * The extracted tsdoc for this entity (module, type, term). If none, is null.
   */
  tsdoc: null | TSDoc
}

export interface TSDoc {
  summary: string
  examples: { text: string }[]
  customTags: { name: string; text: string }[]
  raw: string
}

export type RawFrag = {
  raw: {
    typeText: string
    nodeText: string
    nodeFullText: string
  }
}

export type TypeIndex = Index<IndexableNode>

//
// Export Node
//

export type Expor = {
  kind: 'export'
  name: string
  isTerm: boolean
  isType: boolean
  type: Node
}

type ExporInput = {
  name: string
  node: tsm.ExportedDeclarations
  type: Node
}

export function expor(input: ExporInput): Expor {
  const isType = isTypeLevelNode(input.node)
  return {
    kind: 'export',
    name: input.name,
    type: input.type,
    isType: isType,
    isTerm: !isType,
  }
}

//
// Module Node
//

/**
 * A module (aka. file)
 */
export type Module = TSDocFrag & {
  /**
   * Tells you the kind of data (aka. schema) contained within this object.
   */
  kind: 'module'
  /**
   * The name of the module (aka. file name). File extension or directory path not included.
   */
  name: string
  /**
   * The path to this module from package root. If this module is the main
   * module then the path will be `/`.
   *
   * @remarks
   *
   * This is what a user would place in their import `from` string _following_ the
   * package name. For example:
   *
   * ```ts
   * import foo from "@foo/bar/quux/toto"
   * //                       ^^^^^^^^^^
   * ```
   */
  path: string
  /**
   * Is this module the main one of the package?
   *
   * @remarks
   *
   * The main module of a package is the one that is specified in the
   * package.json "main" field.
   */
  isMain: boolean
  /**
   * Information about the main export from the module. If none, is null.
   *
   * @remarks
   *
   * The "main" export is the one exported using the `export default ...` syntax.
   */
  mainExport: null | Node
  /**
   * Information about the named exports from the module. Being empty means the module
   * does not have any named exports (it may still have a mainExport though).
   */
  namedExports: Expor[]
  /**
   * Detailed location info about the module on disk.
   */
  location: {
    /**
     * The file path to the module relative to the project root.
     */
    filePath: string
  }
}

type ModInput = {
  name: string
  mainExport?: null | Node
  isMain: boolean
  namedExports?: Expor[]
  tsdoc: TSDocFrag['tsdoc']
  path: string
  location: {
    filePath: string
  }
}

export function mod(input: ModInput): Module {
  return {
    kind: 'module',
    mainExport: null,
    namedExports: [],
    ...input,
  }
}

export function modFromSourceFile(manager: Manager, sourceFile: tsm.SourceFile): Module {
  return mod({
    name: sourceFile.getBaseNameWithoutExtension(),
    tsdoc: extractModuleLevelTSDoc(manager, sourceFile),
    path: manager.getImportFromPath(sourceFile),
    isMain: manager.isMainModule(sourceFile),
    location: {
      filePath: path.relative(manager.settings.projectDir, sourceFile.getFilePath()),
    },
  })
}

/**
 * Extract leading TSDoc that pertains to the module as a whole.
 *
 * Leading TSDoc is considered for the module if it is following by nothing,
 * imports, or a node that has its own TSDoc annotation (or any other kind of
 * comment, actually). A non-import node that does not have its own TSDoc would
 * cause the one leading the module to be its doc.
 */
function extractModuleLevelTSDoc(manager: Manager, sf: tsm.SourceFile): TSDocFrag['tsdoc'] {
  //todo why does getChildren return an array? Handle edge-case properly
  const syntaxList = sf.getChildren()[0]!

  if (!tsm.Node.isSyntaxList(syntaxList)) {
    throw new Error(
      `First node of module is not a syntax list. This case is not supported. The node type was ${syntaxList.getKindName()}`
    )
  }

  // Empty syntax list check above should guarnatee a value here
  const firstSyntax = syntaxList.getChildren()[0]

  if (
    // Empty file
    syntaxList.getText() === '' ||
    // Import/export nodes
    tsm.Node.isImportDeclaration(firstSyntax) ||
    tsm.Node.isExportDeclaration(firstSyntax) ||
    // If there are multiple comment blocks then assume the first is for the
    // module and the later one(s) are for the node.
    syntaxList.getLeadingCommentRanges().length > 1
  ) {
    const comment = syntaxList.getLeadingCommentRanges()[0]
    if (comment) {
      return tsDocFromText(manager, comment.getText())
    }
  }

  return null
}

export function tsDocFromText(manager: Manager, raw: string) {
  const tsDocComment = manager.tsdocParser.parseString(raw).docComment
  const examples = []
  const customTags = []
  for (const block of tsDocComment.customBlocks) {
    const tagName = block.blockTag.tagName.replace(/^@/, '')
    if (tagName === 'example') {
      examples.push({
        text: renderTSDocNode(block.content).trim(),
      })
    } else {
      customTags.push({
        name: tagName,
        text: renderTSDocNode(block.content).trim(),
      })
    }
  }
  return {
    raw: raw,
    summary: renderTSDocNode(tsDocComment.summarySection).trim(),
    examples: examples,
    customTags: customTags,
  }
}

//
// Package node
//

/**
 * The root of the extracted JSON that Tydoc produces.
 */
export type Package = {
  /**
   * List of the extracted modules. There may be more than one because a package
   * may officially support importing from multiple modules.
   */
  modules: Module[]
  /**
   * An index of the all the types that have been extracted. This includes three
   * cases:
   *
   * 1. Directly exported types
   * 2. Types referenced directly or indirectly by exported types.
   *
   * If a term is exported but the type it is annotated with is not exported
   * then the type will not appear in the type index and the term's type info will
   * inlined.
   *
   * If a term is exported and so it its annotated type then the term type info
   * will be a reference to the type index.
   *
   * If a term is exported, but the type it is annotated with (A) is not, but the
   * type (A) is referenced by another type (B) that _is_ exported, then the
   * type (A) will appear in the type index referenced by type A, but the term
   * will inline the type info of type A rather than be a type index reference.
   */
  typeIndex: TypeIndex
}

export type GenericInstance = {
  kind: 'generic_instance'
  target: IndexRef
  args: InlinableType[]
} & RawFrag

type GenericInstanceInput = Omit<GenericInstance, 'kind'>

export function genericInstance(input: GenericInstanceInput): GenericInstance {
  return {
    kind: 'generic_instance',
    ...input,
  }
}

// prettier-ignore
export type DocProp = { kind: 'prop'; name: string; type: Node }

export type DocTypeArray = { kind: 'array'; innerType: Node }

export function array(innerType: Node): DocTypeArray {
  return { kind: 'array', innerType }
}
// prettier-ignore
export type DocTypeLiteral = { kind: 'literal'; base: string }

export function literal(input: { name: string; base: string }): DocTypeLiteral {
  return { kind: 'literal', ...input }
}
// prettier-ignore
export type DocTypePrimitive = { kind: 'primitive', type: string }

export function prim(type: string): DocTypePrimitive {
  return { kind: 'primitive', type }
}

/**
 * A link to the type index. All named types go into the type index. When a type
 * or export includes a named type, rather than documenting it inline, a
 * reference to the type index is created.
 *
 */
export type IndexRef = {
  kind: 'typeIndexRef'
  /**
   * An identifier that can be used to lookup the type in the type index.
   *
   * @example
   *
   * ```ts
   * docs.typeIndex[typeIndexRef.link]
   * ```
   */
  link: string
}

export function typeIndexRef(link: string): IndexRef {
  return { kind: 'typeIndexRef', link }
}

export type Alias = {
  kind: 'alias'
  name: string
  type: Node
  /**
   * Type parameters for this alias
   *
   * @example
   * type Foo<A> = {}
   * type Foo<A = string> = {}
   * // todo
   * type Foo<A extends string> = {}
   * type Foo<A extends string = "hello"> = {}
   */
  typeParameters: TypeParameter[]
} & RawFrag &
  TSDocFrag

type AliasInput = Omit<Alias, 'kind'>

export function alias(input: AliasInput): Alias {
  return { kind: 'alias', ...input }
}
export type Interface = {
  kind: 'interface'
  name: string
  props: DocProp[]
  /**
   * Type parameters for this interface
   *
   * @example
   * interface Foo<A> {}
   * interface Foo<A = string> {}
   * // todo
   * interface Foo<A extends string> {}
   * interface Foo<A extends string = "hello"> {}
   */
  typeParameters: TypeParameter[]
} & RawFrag &
  TSDocFrag

/**
 * A type parameter, aka. generic, type variable.
 *
 * @example
 * // aliases
 * type Foo<A> = {}
 * type Foo<A = string> = {}
 * // todo
 * type Foo<A extends string> = {}
 * type Foo<A extends string = "hello"> = {}
 * // interfaces
 * interface Foo<A> {}
 * interface Foo<A = string> {}
 * // todo
 * interface Foo<A extends string> {}
 * interface Foo<A extends string = "hello"> {}
 * // todo functions
 * function foo<A>(){}
 * function foo<A = string>(){}
 * function foo<A extends string>(){}
 * function foo<A extends string = "hello">(){}
 * // todo methods
 * // ...
 */
export type TypeParameter = {
  /**
   * The name of the type parameter.
   *
   * For example in "type A<B> = {}" the name of the first type parameter is "B".
   */
  name: string
  /**
   * The default type for this parameter.
   *
   * @example
   * // The default type is string
   * type Foo<A = string> = {}
   */
  default: null | Unsupported | InlineTypeOrIndexRef
  // todo: interface A<B extends C> {}
  // constraints
} & RawFrag

type InterInput = Omit<Interface, 'kind'>

export function inter(input: InterInput): Interface {
  return { kind: 'interface', ...input }
}
// prettier-ignore
export function prop(input: { name: string, type: Node }): DocProp {
  return { kind: 'prop', ...input }
}
// prettier-ignore
export type DocTypeObject = { kind: 'object'; props: DocProp[] } & RawFrag
// prettier-ignore
type objInput = Omit<DocTypeObject, 'kind'>
// prettier-ignore
export function obj(input: objInput ): DocTypeObject {
  return { kind: 'object', ...input }
}

export type DocTypeCallable = {
  kind: 'callable'
  isOverloaded: boolean
  // todo rename to isNamespace
  hasProps: boolean
  /**
   * Signatures extracted for this function.
   *
   * @remarks
   *
   * This is an array because overloaded functions have multiple signatures. Look at property "isOverloaded" to know if this function is overloaded or not. If it is overloaded that means this array is guaranteed to have two or more signatures. Otherwise this array is guaranteed to have exactly one signature.
   */
  sigs: DocSig[]
  props: DocProp[]
} & RawFrag
// prettier-ignore
type callableInput = Omit<DocTypeCallable, 'kind' | 'isOverloaded' | 'hasProps'>
// prettier-ignore
export function callable(input: callableInput): DocTypeCallable {
  return { kind: 'callable', isOverloaded: input.sigs.length > 1, hasProps: input.props.length > 0, ...input }
}

export type DocSig = { kind: 'sig'; params: DocSigParam[]; return: Node }
// prettier-ignore
export function sig(input: { params: DocSigParam[]; return: Node }): DocSig {
  return { kind: 'sig', ...input }
}
// prettier-ignore
export type DocSigParam = { kind:'sigParam', name: string; type: Node }
// prettier-ignorp
export function sigParam(input: { name: string; type: Node }): DocSigParam {
  return { kind: 'sigParam', ...input }
}
// prettier-ignore
export type Unsupported = { kind:'unsupported', reason: string, } & RawFrag
// prettier-ignorp
export function unsupported(raw: RawFrag, reason: string): Unsupported {
  return { kind: 'unsupported', reason, ...raw }
}

//
// Intersection Node
//

export type DocTypeIntersection = {
  kind: 'intersection'
  types: Node[]
} & RawFrag

type IntersectionInput = Omit<DocTypeIntersection, 'kind'>

export function intersection(input: IntersectionInput): DocTypeIntersection {
  return { kind: 'intersection', ...input }
}

//
// Union Node
//

// prettier-ignore
export type DocTypeUnion = { kind:'union', isDiscriminated: boolean, discriminantProperties: null | string[], types: Node[] } & RawFrag

type UnionInput = { types: Node[]; discriminantProperties: string[] } & RawFrag

export function union(input: UnionInput): DocTypeUnion {
  return {
    kind: 'union',
    ...input,
    isDiscriminated: input.discriminantProperties.length > 0,
    discriminantProperties: input.discriminantProperties.length > 0 ? input.discriminantProperties : null,
  }
}

export type StandardLibrary = {
  kind: 'standard_library'
  name: string
  location: {
    modulePath: string
  }
} & RawFrag

type StandardLibraryInput = Omit<StandardLibrary, 'kind'>

export function standardlibrary(input: StandardLibraryInput): StandardLibrary {
  return {
    kind: 'standard_library',
    ...input,
  }
}
