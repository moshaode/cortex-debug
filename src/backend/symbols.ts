import * as childProcess from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as tmp from 'tmp';
import * as fs from 'fs';
import * as crypto from 'crypto';

import { SymbolType, SymbolScope, SymbolInformation } from '../symbols';
import { MI2 } from './mi2/mi2';
import { MINode } from './mi_parse';

const SYMBOL_REGEX = /\n([0-9a-f]{8})\s([lg\ !])([w\ ])([C\ ])([W\ ])([I\ ])([dD\ ])([FfO\ ])\s(.*?)\s+([0-9a-f]+)\s([^\r\n]+)/mg;
// DW_AT_name && DW_AT_comp_dir may have optional stuff that looks like '(indirect string, offset: 0xf94): '
const COMP_UNIT_REGEX = /\n <0>.*\(DW_TAG_compile_unit\)[\s\S]*?DW_AT_name[\s]*: (\(.*\):\s)?(.*)[\r\n]+([\s\S]*?)\n </mg;
// DW_AT_comp_dir may not exist
const COMP_DIR_REGEX = /DW_AT_comp_dir[\s]*: (\(.*\):\s)?(.*)[\r\n]+/m;
const debugConsoleLogging = false;

const TYPE_MAP: { [id: string]: SymbolType } = {
    'F': SymbolType.Function,
    'f': SymbolType.File,
    'O': SymbolType.Object,
    ' ': SymbolType.Normal
};

const SCOPE_MAP: { [id: string]: SymbolScope } = {
    'l': SymbolScope.Local,
    'g': SymbolScope.Global,
    ' ': SymbolScope.Neither,
    '!': SymbolScope.Both
};

export class MemoryRegion {
    public vmaEnd: number;      // Inclusive
    public lmaEnd: number;      // Exclusive
    constructor(
        public name: string,
        public size: number,
        public vmaStart: number,   // Virtual memory address
        public lmaStart: number,   // Load memory address
        public attrs: string[]
    ) {
        this.vmaEnd = this.vmaStart + this.size + 1;
        this.lmaEnd = this.lmaStart + this.size + 1;
    }

    public inVmaRegion(addr: number) {
        return (addr >= this.vmaStart) && (addr < this.vmaEnd);
    }

    public inLmaRegion(addr: number) {
        return (addr >= this.lmaStart) && (addr < this.lmaEnd);
    }

    public inRegion(addr: number) {
        return this.inVmaRegion(addr) || this.inLmaRegion(addr);
    }
}

export class SymbolTable {
    private allSymbols: SymbolInformation[] = [];

    // The following are caches that are either created on demand or on symbol load. Helps performance
    // on large executables since most of our searches are linear. Or, to avoid a search entirely if possible
    // Case sensitivity for path names is an issue: We follow just what gcc records so inherently case-sensitive
    // or case-preserving. We don't try to re-interpret/massage those path-names. Maybe later.
    //
    // TODO: Support for source-maps for both gdb and for symbol/file lookups
    // TODO: some of the arrays below should be maps. Later.
    private staticsByFile: {[file: string]: SymbolInformation[]} = {};
    private globalVars: SymbolInformation[] = [];
    private globalFuncsMap: {[key: string]: SymbolInformation} = {};    // Key is function name
    private staticVars: SymbolInformation[] = [];
    private staticFuncsMap: {[key: string]: SymbolInformation[]} = {};  // Key is function name
    private fileMap: {[key: string]: string[]} = {};                    // basename of a file to a potential list of aliases we found
    public memoryRegions: MemoryRegion[] = [];

    constructor(
        private gdb: MI2, toolchainPath: string,
        toolchainPrefix: string, private objdumpPath: string, private executable: string)
    {
        if (!this.objdumpPath) {
            this.objdumpPath = os.platform() !== 'win32' ? `${toolchainPrefix}-objdump` : `${toolchainPrefix}-objdump.exe`;
            if (toolchainPath) {
                this.objdumpPath = path.normalize(path.join(toolchainPath, this.objdumpPath));
            }
        }
    }

    private async loadSymbolFilesFromGdb(): Promise<boolean> {
        try {
            this.gdb.startCaptureConsole();
            await this.gdb.sendCommand('interpreter-exec console "info sources"');
            const str = this.gdb.endCaptureConsole();
            const lines = str.split(/[\r\n]+/g);
            for (let line of lines) {
                line = line.trim();
                if ((line === '') || line.endsWith(':')) {
                    continue;
                }
                const files = line.split(/\,\s/g);
                for (const f of files) {
                    this.addPathVariations(f);
                }
            }
        }
        catch {
            const str = this.gdb.endCaptureConsole();
            console.error('gdb info sources failed');
            return false;
        }
    }

    private loadSymbolFilesFromGdbUnused(): Promise<boolean> {
        return new Promise(async (resolve, reject) => {
            if (!this.gdb || this.gdb.gdbMajorVersion < 9) {
                return resolve(false);
            }

            function getProp(ary: any, name: string): any {
                if (ary) {
                    for (const item of ary) {
                        if (item[0] === name) {
                            return item[1];
                        }
                    }
                }
                return undefined;
            }

            try {
                const miNode: MINode = await this.gdb.sendCommand('symbol-info-variables');
                const results = getProp(miNode?.resultRecords?.results, 'symbols');
                const dbgInfo = getProp(results, 'debug');
                if (dbgInfo) {
                    for (const file of dbgInfo) {
                        const fullname = getProp(file, 'fullname');
                        const filename = getProp(file, 'filename');
                        if (fullname) {
                            this.addPathVariations(fullname);
                        }
                        if (filename && (filename !== fullname)) {
                            this.addPathVariations(filename);
                        }
                        // We just need to know what source files are intresting. Don't really care what
                        // symbols are in there. Super expensive way to find out
                        /*
                        const symbols = getProp(file, 'symbols');
                        if (symbols && (symbols.length > 0) && (filename || fullname)) {
                            for (const sym of symbols) {
                                const name = getProp(sym, 'name');
                                const description = getProp(sym, 'description') as string;
                                // maybe a more sophisticated way is needed to determine a static
                                const isStatic = description && description.startsWith('static');
                                if (isStatic) {
                                    if (fullname) {
                                        this.addPathVariations(fullname);
                                        // this.addToFileMap(fullname, name);
                                    }
                                    if (filename && (filename !== fullname)) {
                                        this.addPathVariations(filename);
                                        // this.addToFileMap(filename, name);
                                    }
                                }
                            }
                        }
                        */
                    }
                }
            }
            catch {
                console.error('symbol-info-variables failed');
                return resolve(false);
            }

            // TODO: We should also get statuc function names but that is very slow. In the future, we will probably
            // be doing full disassembly so ignore it until it is a real issue.
            return resolve(true);
        });
    }

    /**
     * Most symbol tables are manageable in size. Problem is by default, `objdump --syms` does not give
     * give you actual file names, just base file name. Well, that only works if all files are compiled
     * in the current directory of source and you can have duplicates. We ask gdb for variable info which
     * is not that fast either but better than the -Wi option. But this is only possible with gdb version
     * 9+ and then we resort to using the '-Wi' to dump debug section to determine all the compilation units
     * and the directory they were from (relative path and a dir) Gdb uses the relative path (and the full path).
     * This is needed when looking up static vars/funcs.
     *
     * Problem is `-Wi` produces extremely huge output, that default `spawnSync` buffer overflows and we
     * get truncated results. So we have to output to a file and read that file. Hope we all have SSDs...
     *
     * Next problem is parsing line by line is very slow. We are talking multiple seconds even on a fast
     * machine. So, we try to parse the objdump output without converting to lines. The file mapping produced
     * by -Wi can be so large that we have to cache it in a tmp dir. So, we use the '-Wi' sparingly. For
     * now, we do not cache the actual symbols because that JSON file would become huge. It is faster to
     * re-parse the objdump output each time.
     * 
     * Even using the '-Wi', it is not bullet proof in matching sym-table to file names. A lot more work
     * would be needed to do that. Wish gdb could give us that info rather than using objdump, but testing
     * showed that it is both complex and very slow.
     * *
     * We still have to use objdump because gdb does not give important info like (function end addresses,
     * no clear scope of objects). We have switched to using gdb for variable info because of Issue #539
     * where the output of objdump was in Gigabytes when using the -Wi option
     */

    public loadSymbols(noCache: boolean = false, useObjdumpFname: string = ''): Promise<void> {
        return new Promise(async (resolve, reject) => {
            try {
                /*
                let objdumpExePath = 
                os.platform() !== 'win32' ? `${this.toolchainPrefix}-objdump` : `${this.toolchainPrefix}-objdump.exe`;
                if (this.toolchainPath) {
                    objdumpExePath = path.normalize(path.join(this.toolchainPath, objdumpExePath));
                }
                */
                const restored = noCache ? false : this.deSerializeFileMaps(this.executable);
                const options = ['--syms', '-C', '-h', '-w'];
                let didGetInfoFromGdb = false;
                if (!restored) {
                    didGetInfoFromGdb = await this.loadSymbolFilesFromGdb();    // Even this is not super fast but faster
                    if (!didGetInfoFromGdb) {
                        options.push('-Wi');    // WARNING! Creates super large output
                    }
                }

                if (!useObjdumpFname || !fs.existsSync(useObjdumpFname)) {
                    useObjdumpFname = tmp.tmpNameSync();
                    const outFd = fs.openSync(useObjdumpFname, 'w');
                    const objdump = childProcess.spawnSync(this.objdumpPath, [...options, this.executable], {
                        stdio: ['ignore', outFd, 'ignore']
                    });
                    fs.closeSync(outFd);
                }
                const str = this.readLinesAndFileMaps(useObjdumpFname, !restored && !didGetInfoFromGdb);

                const regex = RegExp(SYMBOL_REGEX);
                let currentFile: string = null;
                let match: RegExpExecArray;
                while ((match = regex.exec(str)) !== null) {
                    if (match[7] === 'd' && match[8] === 'f') {
                        if (match[11]) {
                            currentFile = SymbolTable.NormalizePath(match[11].trim());
                        } else {
                            // This can happen with C++. Inline and template methods/variables/functions/etc. are listed with
                            // an empty file association. So, symbols after this line can come from multiple compilation
                            // units with no clear owner. These can be locals, globals or other.
                            currentFile = null;
                        }
                    }
                    const type = TYPE_MAP[match[8]];
                    const scope = SCOPE_MAP[match[2]];
                    let name = match[11].trim();
                    let hidden = false;

                    if (name.startsWith('.hidden')) {
                        name = name.substring(7).trim();
                        hidden = true;
                    }

                    const sym: SymbolInformation = {
                        address: parseInt(match[1], 16),
                        type: type,
                        scope: scope,
                        section: match[9].trim(),
                        length: parseInt(match[10], 16),
                        name: name,
                        file: scope === SymbolScope.Local ? currentFile : null,
                        instructions: null,
                        hidden: hidden
                    };
                    this.allSymbols.push(sym);
                }
                this.categorizeSymbols();
                this.sortGlobalVars();

                if (!restored && !noCache) {
                    this.serializeFileMaps(this.executable);
                }
                resolve();
            }
            catch (e) { resolve(); }
        });
    }

    private sortGlobalVars() {
        // We only sort globalVars. Want to preserve statics original order though.
        this.globalVars.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));

        // double underscore variables are less interesting. Push it down to the bottom
        const doubleUScores: SymbolInformation[] = [];
        while (this.globalVars.length > 0) {
            if (this.globalVars[0].name.startsWith('__')) {
                doubleUScores.push(this.globalVars.shift());
            } else {
                break;
            }
        }
        this.globalVars = this.globalVars.concat(doubleUScores);
    }

    private categorizeSymbols() {
        for (const sym of this.allSymbols) {
            const scope = sym.scope;
            const type = sym.type;
            if (scope !== SymbolScope.Local) {
                if (type === SymbolType.Function) {
                    sym.scope = SymbolScope.Global;
                    this.globalFuncsMap[sym.name] = sym;
                } else if (type === SymbolType.Object) {
                    if (scope === SymbolScope.Global) {
                        this.globalVars.push(sym);
                    } else {
                        // These fail gdb create-vars. So ignoring them. C++ generates them.
                        if (debugConsoleLogging) {
                            console.log('SymbolTable: ignoring non local object: ' + sym.name);
                        }
                    }
                }
            } else if (sym.file) {
                // Yes, you can have statics with no file association in C++. They are neither
                // truly global or local. Some can be considered global but not sure how to filter.
                if (type === SymbolType.Object) {
                    this.staticVars.push(sym);
                } else if (type === SymbolType.Function) {
                    const tmp = this.staticFuncsMap[sym.name];
                    if (tmp) {
                        tmp.push(sym);
                    } else {
                        this.staticFuncsMap[sym.name] = [sym];
                    }
                }
            } else if (type === SymbolType.Function) {
                sym.scope = SymbolScope.Global;
                this.globalFuncsMap[sym.name] = sym;
            } else if (type === SymbolType.Object) {
                // We are currently ignoring Local objects with no file association for objects.
                // Revisit later with care and decide how to classify them
                if (debugConsoleLogging) {
                    console.log('SymbolTable: ignoring local object: ' + sym.name);
                }
            }
        }
    }

    public printSyms(cb?: (str: string) => any) {
        cb = cb || console.log;
        for (const sym of this.allSymbols) {
            let str = sym.name ;
            if (sym.type === SymbolType.Function) {
                str += ' (f)';
            } else if (sym.type === SymbolType.Object) {
                str += ' (o)';
            }
            if (sym.file) {
                str += ' (s)';
            }
            cb(str);
            if (sym.file) {
                const maps = this.fileMap[sym.file];
                if (maps) {
                    for (const f of maps) {
                        cb('\t' + f);
                    }
                } else {
                    cb('\tNoMap for? ' + sym.file);
                }
            }
        }
    }

    public printToFile(fName: string): void {
        try {
            const outFd = fs.openSync(fName, 'w');
            this.printSyms((str) => {
                fs.writeSync(outFd, str);
                fs.writeSync(outFd, '\n');
            });
            fs.closeSync(outFd);
        }
        catch (e) {
            console.log('printSymsToFile: failed' + e);
        }
    }

    private addToFileMap(key: string, newMap: string): string[] {
        console.log(key, newMap);
        newMap = SymbolTable.NormalizePath(newMap);
        const value = this.fileMap[key] || [];
        if (value.indexOf(newMap) === -1) {
            value.push(newMap);
        }
        this.fileMap[key] = value;
        return value;
    }

    protected readLinesAndFileMaps(fileName: string, readFileMaps: boolean): string {
        try {
            const start = Date.now();
            let str = fs.readFileSync(fileName, {encoding: 'utf8'});
            if (readFileMaps) {
                let counter = 0;
                let match: RegExpExecArray;
                let end = str.length;
                const compUnit = RegExp(COMP_UNIT_REGEX);
                while ((match = compUnit.exec(str)) !== null) {
                    if (end > match.index) {
                        end = match.index;
                    }
                    const { curSimpleName, curName } = this.addPathVariations(match[2]);
                    const compDir = RegExp(COMP_DIR_REGEX);
                    match = compDir.exec(match[3]);
                    if (match) {
                        // Do not use path.join below. Match[1] can be in non-native form. Will be fixed by addToFileMap.
                        this.addToFileMap(curSimpleName, match[2] + '/' + curName);
                    }
                    counter++;
                }
                const diff = Date.now() - start;
                if (debugConsoleLogging) {
                    console.log(`Runtime = ${diff}ms`);
                }
                if (end !== str.length) {
                    str = str.substring(0, end);
                }
            }
            const memRegionsEnd = RegExp(/^SYMBOL TABLE:\r?\n/m);
            let match = memRegionsEnd.exec(str);
            if (match) {
                const head = str.substring(0, match.index);
                str = str.substring(match.index);
                // Header:
                // Idx Name          Size      VMA       LMA       File off  Algn
                // Sample entry:
                //   0 .cy_m0p_image 000025d4  10000000  10000000  00010000  2**2
                //                   CONTENTS, ALLOC, LOAD, READONLY, DATA
                //                                    1          2          3          4          5          6         7
                // const entry = RegExp(/^\s*[0-9]+\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)[^\n]+\n\s*([^\r\n]*)\r?\n/gm);
                const entry = RegExp(/^\s*[0-9]+\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\r\n]*)\r?\n/gm);
                while (match = entry.exec(head)) {
                    const attrs = match[7].trim().toLowerCase().split(/[,\s]+/g);
                    if (!attrs.find((s) => s === 'alloc')) {
                        // Technically we only need regions marked for code but lets get all non-debug, non-comment stuff
                        continue;
                    }
                    const region = new MemoryRegion(
                        match[1],
                        parseInt(match[2], 16),  // size
                        parseInt(match[3], 16),  // vma
                        parseInt(match[4], 16),  // lma
                        attrs
                    );
                    this.memoryRegions.push(region);
                }
            }

            return str;
        }
        catch (e) {
            return '';
        }
    }

    private addPathVariations(fileString: string) {
        const curName = SymbolTable.NormalizePath(fileString);
        const curSimpleName = path.basename(curName);
        this.addToFileMap(curSimpleName, curSimpleName);
        this.addToFileMap(curSimpleName, curName);
        return { curSimpleName, curName };
    }

    protected getFileNameHashed(fileName: string): string {
        try {
            fileName = SymbolTable.NormalizePath(fileName);
            const schemaVer = 2;   // Please increment if schema changes or how objdump is invoked changes
            const ver = `v${schemaVer}-gdb.${this.gdb.gdbMajorVersion}.${this.gdb.gdbMinorVersion}}`;
            const stats = fs.statSync(fileName);            // Can fail
            const str = `${fileName}-${stats.mtimeMs}-${os.userInfo().username}-${ver}`;
            const hasher = crypto.createHash('sha256');
            hasher.update(str);
            const ret = hasher.digest('hex');
            return ret;
        }
        catch (e) {
            throw(e);
        }
    }

    private createFileMapCacheFileName(fileName: string) {
        const hash = this.getFileNameHashed(fileName) + '.json';
        const fName = path.join(os.tmpdir(), 'Cortex-Debug-' + hash);
        return fName;
    }

    protected serializeFileMaps(fileName: string): void {
        try {
            const fName = this.createFileMapCacheFileName(fileName);
            const data = JSON.stringify(this.fileMap, null, ' ');
            fs.writeFileSync(fName, data, {encoding: 'utf8'});
            if (debugConsoleLogging) {
                console.log(`data saved to ${fName}`);
            }
        }
        catch (e) {
            console.log(e.toString());
        }
    }

    protected deSerializeFileMaps(fileName: string): boolean {
        try {
            const fName = this.createFileMapCacheFileName(fileName);
            if (!fs.existsSync(fName)) { return false; }
            const data = fs.readFileSync(fName, {encoding: 'utf8'});
            this.fileMap = JSON.parse(data);
            if (debugConsoleLogging) {
                console.log(`data restored from ${fName}`);
            }
            try {
                // On a mac, try to touch the file to keep it from getting purged
                const tm = Date.now();
                fs.utimesSync(fName, tm, tm);
            }
            catch {}
            return true;
        }
        catch (e) {
            if (debugConsoleLogging) {
                console.log(e.toString());
            }
            return false;
        }
    }
    
    public getFunctionAtAddress(address: number): SymbolInformation {
        return this.allSymbols.find((s) => s.type === SymbolType.Function && s.address <= address && (s.address + s.length) > address);
    }

    public getFunctionSymbols(): SymbolInformation[] {
        return this.allSymbols.filter((s) => s.type === SymbolType.Function);
    }

    public getGlobalVariables(): SymbolInformation[] {
        return this.globalVars;
    }

    public getStaticVariables(file: string): SymbolInformation[] {
        if (!file) {
            return [];
        }
        file = SymbolTable.NormalizePath(file);
        let ret = this.staticsByFile[file];
        if (!ret) {
            ret = [];
            for (const s of this.staticVars) {
                const maps = this.fileMap[s.file];
                if (maps && (maps.indexOf(file) !== -1)) {
                    ret.push(s);
                }
            }
            this.staticsByFile[file] = ret;
        }
        return ret;
    }

    public getFunctionByName(name: string, file?: string): SymbolInformation {
        if (file) {      // Try to find static function first
            file = SymbolTable.NormalizePath(file);
            const syms = this.staticFuncsMap[name];
            if (syms) {
                for (const s of syms) {                 // Try exact matches first (maybe not needed)
                    if (s.file === file) { return s; }
                }
                for (const s of syms) {                 // Try any match
                    const maps = this.fileMap[s.file];  // Bunch of files/aliases that may have the same symbol name
                    if (maps && (maps.indexOf(file) !== -1)) {
                        return s;
                    }
                }
            }
        }

        // Fall back to global scope
        const ret = this.globalFuncsMap[name];
        return ret;
    }

    public getGlobalOrStaticVarByName(name: string, file?: string): SymbolInformation {
        if (file) {      // If a file is given only search for static variables by file
            file = SymbolTable.NormalizePath(file);
            for (const s of this.staticVars) {
                if ((s.name === name) && (s.file === file)) {
                    return s;
                }
            }
            return null;
        }

        // Try globals first and then statics
        for (const s of this.globalVars.concat(this.staticVars)) {
            if (s.name === name) {
                return s;
            }
        }

        return null;
    }

    public static NormalizePath(pathName: string): string {
        if (!pathName) { return pathName; }
        if (os.platform() === 'win32') {
            // Do this so path.normalize works properly
            pathName = pathName.replace(/\//g, '\\');
        } else {
            pathName = pathName.replace(/\\/g, '/');
        }
        pathName = path.normalize(pathName);
        if (os.platform() === 'win32') {
            pathName = pathName.toLowerCase();
        }
        return pathName;
    }
}
