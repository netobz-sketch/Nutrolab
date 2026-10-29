/** Validação de CPF (dígitos verificadores). Devolve só os 11 dígitos ou null. */
export function normalizeCpf(input: string | null | undefined): string | null {
  const digits = (input ?? '').replace(/\D/g, '');
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return null;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(digits[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  if (calc(9) !== Number(digits[9]) || calc(10) !== Number(digits[10])) return null;
  return digits;
}

export function formatCpf(digits: string | null): string {
  if (!digits || digits.length !== 11) return '';
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

export const COUNCILS: Record<string, string> = { CRM: 'CRM (médico)', CRN: 'CRN (nutricionista)' };
export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

export function normalizeCouncilNumber(input: string | null | undefined): string {
  return (input ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}
