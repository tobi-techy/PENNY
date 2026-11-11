import { ulid } from 'ulid';

export type IdPrefix =
  | 'usr'
  | 'apr'
  | 'dev'
  | 'bot'
  | 'msg'
  | 'cnv'
  | 'mem'
  | 'led'
  | 'gdc'
  | 'atch'
  | 'evt'
  | 'bil'
  | 'cmt'
  | 'cev'
  | 'crd'
  | 'pky'
  | 'rmd';

export function newId<P extends IdPrefix>(prefix: P): `${P}_${string}` {
  return `${prefix}_${ulid()}`;
}
