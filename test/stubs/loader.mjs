/**
 * Module loader that maps `openclaw/plugin-sdk/plugin-entry` to a local stub
 * when the real `openclaw` package is not installed. Registered via
 * `node --import ./test/stubs/loader-register.mjs`.
 */
const STUB = new URL("./openclaw.js", import.meta.url).href;
const TARGET = "openclaw/plugin-sdk/plugin-entry";

export async function resolve(specifier, context, nextResolve) {
    if (specifier === "openclaw/plugin-sdk/secret-input-runtime") return { url: new URL("./secrets.js", import.meta.url).href, shortCircuit: true };
    if (specifier === "openclaw/plugin-sdk/memory-host-search") return { url: new URL("./memory-host-search.js", import.meta.url).href, shortCircuit: true };
    if (specifier === TARGET) {
        return { url: STUB, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
