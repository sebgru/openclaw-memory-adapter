/**
 * Minimal local stand-in for the `openclaw` package's plugin-sdk module.
 * OpenClaw injects the real module at runtime; tests and CI use this stub so
 * the plugin entry can be imported and covered without a running Gateway.
 *
 * If the openclaw package is installed (peer dependency), Node resolves to the
 * real implementation instead because this mapping only applies when the
 * package is missing.
 */
export function definePluginEntry(definition) {
    return definition;
}
