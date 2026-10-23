/**
 * Validacao do formulario ANTES de enviar: resposta imediata e com acento. O servidor valida de novo
 * (sempre) e e a autoridade; estas regras espelham as dele para a pessoa nao esperar a rede.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Mesma lista recusada pelo servidor (application/validation.ts). */
const COMMON_PASSWORDS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  '87654321',
  'password',
  'password1',
  'senha123',
  'senha1234',
  'qwertyui',
  'qwerty123',
  'iloveyou',
  'abc12345',
  'admin123',
  'leilao123',
  '00000000',
  '11111111',
]);

export function validateEmail(value: string): string | undefined {
  const email = value.trim();
  if (email === '') return 'Informe o e-mail.';
  if (email.length > 254) return 'E-mail muito longo.';
  if (!EMAIL.test(email)) return 'E-mail inválido.';
  return undefined;
}

export function validateNewPassword(value: string): string | undefined {
  if (value === '') return 'Crie uma senha.';
  if (value.length < 8) return 'Use pelo menos 8 caracteres.';
  if (value.length > 128) return 'Use no máximo 128 caracteres.';
  if (COMMON_PASSWORDS.has(value.toLowerCase())) return 'Essa senha é muito comum. Escolha outra.';
  if (new Set(value).size <= 2) return 'Essa senha é muito repetitiva. Escolha outra.';
  return undefined;
}

export function validateDisplayName(value: string): string | undefined {
  const name = value.trim();
  if (name.length < 2) return 'Informe seu nome (pelo menos 2 letras).';
  if (name.length > 60) return 'Use no máximo 60 caracteres.';
  return undefined;
}

export interface LoginErrors {
  email?: string;
  password?: string;
}

export function validateLogin(input: { email: string; password: string }): LoginErrors {
  const errors: LoginErrors = {};
  const email = validateEmail(input.email);
  if (email !== undefined) errors.email = email;
  if (input.password === '') errors.password = 'Informe a senha.';
  return errors;
}

export interface RegisterErrors {
  displayName?: string;
  email?: string;
  password?: string;
}

export function validateRegister(input: {
  displayName: string;
  email: string;
  password: string;
}): RegisterErrors {
  const errors: RegisterErrors = {};
  const name = validateDisplayName(input.displayName);
  const email = validateEmail(input.email);
  const password = validateNewPassword(input.password);
  if (name !== undefined) errors.displayName = name;
  if (email !== undefined) errors.email = email;
  if (password !== undefined) errors.password = password;
  return errors;
}
