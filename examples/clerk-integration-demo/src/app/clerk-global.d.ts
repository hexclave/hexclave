declare global {
  type ClerkUser = {
    fullName: string | null,
    firstName: string | null,
    primaryEmailAddress?: { emailAddress: string } | null,
  };

  type ClerkSession = {
    id: string,
    getToken: () => Promise<string | null>,
  };

  type ClerkInstance = {
    user: ClerkUser | null,
    session: ClerkSession | null,
    load: (options?: { publishableKey?: string }) => Promise<void>,
    openSignIn: () => Promise<void>,
    signOut: () => Promise<void>,
    addListener: (callback: () => void) => () => void,
  };

  // Interface merging is required to add Clerk to the browser's Window type.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    Clerk?: ClerkInstance,
  }
}

export {};
