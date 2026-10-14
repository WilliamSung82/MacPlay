import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
export const dataDir = process.env.MACPLAY_DATA || join(homedir(), 'Library/Application Support/MacPlay Video')
export const app = { getPath: (_:string) => dataDir }
export function writeFileAtomic(path:string, text:string, mode = 0o600): void {
 mkdirSync(dirname(path), {recursive:true, mode:0o700}); writeFileSync(path+'.new',text,{mode}); renameSync(path+'.new',path)
}
