import "nitro/types";

// Nitro 3.0.0 ships a dangling nitro/presets type import, omitting preset
// options from NitroConfig. Its Vercel preset does implement vercel.config;
// describe the Build Output API subset used here until upstream ships the types.
declare module "nitro/types" {
  // Declaration merging requires an interface rather than a type alias.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface NitroConfig {
    vercel?: {
      config?: {
        routes?: {
          src: string,
          has?: { type: "host", value: string }[],
          dest: string,
          headers?: Record<string, string>,
        }[],
      },
    },
  }
}
