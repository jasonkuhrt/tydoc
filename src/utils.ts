import { inspect } from 'util'

export type Index<T> = Record<string, T>

export type Thunk<T> = () => T

/**
 * Use this to make assertion at end of if-else chain that all members of a
 * union have been accounted for.
 */
export function casesHandled(x: never): never {
  throw new Error(`A case was not handled for value: ${x}`)
}

export function dump(...args: any[]) {
  const argsInspected = args.map(a => inspect(a, { depth: 20 }))
  console.error(...argsInspected)
}
