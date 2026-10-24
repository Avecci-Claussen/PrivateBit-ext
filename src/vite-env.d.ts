/// <reference types="vite/client" />

declare module "*.css";

/** Set only by `npm run build:private` (vite --mode private). Every other build defines it as undefined. */
declare const __PB_PRIVATE_UNISAT__: string | undefined;
