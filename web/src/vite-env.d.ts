/// <reference types="vite/client" />

import '@tanstack/react-query';

declare module '@tanstack/react-query' {
  interface Register {
    /** `private: true` marks per-user data that is dropped from the cache on logout. */
    queryMeta: { private?: boolean };
  }
}
