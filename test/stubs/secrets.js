export const getPreparedPluginSecretInput = (_plugin, path) => {
  if (path === "mail.accessToken") {
    if (globalThis.__mailTestCredential instanceof Error) throw globalThis.__mailTestCredential;
    return { value: globalThis.__mailTestCredential };
  }
  return { value: globalThis.__factsTestCredential };
};
