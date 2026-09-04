export const isReactServer = true;


// In Next.js 15, the `next/headers` module returns async functions.
// Since we support both Next.js 14 and 15, we return a union of the two.
// TODO: Remove this once we drop support for Next.js 14, and replace it with `export { cookies, headers } from 'next/headers';`
// https://nextjs.org/blog/next-15#async-request-apis-breaking-change
import { cookies as nextCookies, headers as nextHeaders } from './next-static-analysis-workaround';
export const cookies: typeof nextCookies | ((...args: Parameters<typeof nextCookies>) => Promise<ReturnType<typeof nextCookies>>) = nextCookies;
export const headers: typeof nextHeaders | ((...args: Parameters<typeof nextHeaders>) => Promise<ReturnType<typeof nextHeaders>>) = nextHeaders;
