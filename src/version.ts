import pkg from "../package.json";

/** Inlined from package.json, so compiled binaries carry it too. */
export const VERSION: string = pkg.version;
