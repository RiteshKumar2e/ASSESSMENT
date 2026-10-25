/// <reference types="vite/client" />

// Every VITE_* value is compiled into the public bundle: never put secrets here.
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_CONTACT_EMAIL?: string;
  readonly VITE_OPERATOR_NAME?: string;
  readonly VITE_SITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
