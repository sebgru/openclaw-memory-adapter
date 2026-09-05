/**
 * Module loader that maps `openclaw/plugin-sdk/plugin-entry` to a local stub
 * when the real `openclaw` package is not installed. Registered via
 * `node --import ./test/stubs/loader-register.mjs`.
 */
const STUB = new URL("./openclaw.js", import.meta.url).href;
const TARGET = "openclaw/plugin-sdk/plugin-entry";

export async function resolve(specifier, context, nextResolve) {
    if (specifier === TARGET) {
        return { url: STUB, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
