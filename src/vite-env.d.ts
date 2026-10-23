/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_UNISAT_API_KEY?: string;
  readonly VITE_UNISAT_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
