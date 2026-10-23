/**
 * Contas de demonstracao (criadas pelo seed). A senha e publica DE PROPOSITO: quem avalia o projeto
 * precisa conseguir entrar. Em producao real, desligue com VITE_SHOW_DEMO_HINT=false.
 */
export const SHOW_DEMO_HINT: boolean = import.meta.env.VITE_SHOW_DEMO_HINT !== 'false';

export const DEMO_PASSWORD: string =
  typeof import.meta.env.VITE_DEMO_PASSWORD === 'string' &&
  import.meta.env.VITE_DEMO_PASSWORD !== ''
    ? import.meta.env.VITE_DEMO_PASSWORD
    : 'Demo-Leilao-2026!';

export const DEMO_ACCOUNTS = [
  { label: 'Leiloeiro', email: 'leiloeiro@demo.leilao' },
  { label: 'Licitante Ana', email: 'ana@demo.leilao' },
  { label: 'Licitante Bruno', email: 'bruno@demo.leilao' },
] as const;
