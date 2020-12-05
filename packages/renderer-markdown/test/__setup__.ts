import * as tydocExtractor from '@tydoc/extractor'
import * as Path from 'path'
import * as Prettier from 'prettier'
import * as tsm from 'ts-morph'
import * as tydocMarkdownRenderer from '../source'

interface ModuleSpec {
  /**
   * Should this module be an entrypoint for Tydoc? If not it means the module
   * is not intended for users to access and its contents will not be documented
   * unless referenced by things that are.
   */
  isEntrypoint?: boolean
  /**
   * Code that the module contains.
   */
  content: string
  /**
   * The path to place the module under the src directory. By default the module
   * will be placed directly under the "src" directory.
   */
  modulePathUnderSrc?: string
  /**
   * The name of the module. By default an alphabet letter increasing for each
   * subsequent module given among the parameters.
   */
  moduleName?: string
}

function createContextt() {
  const tsMorphProject = new tsm.Project({
    compilerOptions: {
      rootDir: './src',
      outDir: './dist',
    },
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: true,
  })

  const api = {
    markdown(opts: tydocMarkdownRenderer.Options, ...sources: (string | ModuleSpec)[]) {
      return tydocMarkdownRenderer.render(api.extract(...sources), opts)
    },
    /**
     * Pass a set of synthetic source files. The first source is considered the
     * entrypoint. Files are named by alphabet letters, starting from "a",
     * incrementing toward "z".
     */
    extract(...modules: (string | ModuleSpec)[]) {
      const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
      const entrypoints = ['a']
      for (const mod of modules) {
        const content = typeof mod === 'string' ? mod : mod.content
        const contentPretty = Prettier.format(content, { parser: 'typescript' })
        const moduleName =
          typeof mod === 'object' ? (mod.moduleName ? mod.moduleName : letters.shift()!) : letters.shift()!
        const modulePathUnderSrc =
          typeof mod === 'object' ? (mod.modulePathUnderSrc ? mod.modulePathUnderSrc : '') : ''
        if (typeof mod === 'object' && mod.isEntrypoint) {
          entrypoints.push(Path.join(modulePathUnderSrc, moduleName))
        }
        const modulePath = Path.join(`src`, modulePathUnderSrc, `${moduleName}.ts`)
        tsMorphProject.createSourceFile(modulePath, contentPretty, {
          overwrite: true,
        })
      }
      return tydocExtractor.fromProject({
        entrypoints: entrypoints,
        layout: {
          tsMorphProject,
          validateExists: false,
          sourceMainModulePath: 'src/a.ts',
          projectDir: '/',
          sourceDir: 'src',
          packageJson: {
            main: tsMorphProject.compilerOptions.get().outDir + '/a.js',
          },
        },
      })
    },
  }

  return api
}

const ctxx = createContextt()

declare global {
  export const createContext: typeof createContextt
  export const ctx: typeof ctxx
  namespace NodeJS {
    interface Global {
      createContext: typeof createContextt
      ctx: typeof ctxx
    }
  }
}

Object.assign(global, {
  createContext: createContextt,
  ctx: ctxx,
})