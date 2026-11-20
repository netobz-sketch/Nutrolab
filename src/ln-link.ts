import { gotruePasswordConfigured } from './sso.js';

/**
 * Link de volta ao prontuário do paciente no LN Evolution.
 * Só existe quando LN_EVOLUTION_PUBLIC_URL é uma URL http(s) válida E o caso trouxe o
 * id do paciente no LN (campo `lnPatientId` do POST /api/integration/cases). Sem
 * qualquer um dos dois, nada aparece na tela.
 */
export function lnEvolutionBase(raw: string | undefined = process.env.LN_EVOLUTION_PUBLIC_URL): string | null {
  return publicHttpBase(raw);
}

/** URL pública http(s) sem usuário, query nem hash, sem a barra final; senão null. */
export function publicHttpBase(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Id do paciente no LN Evolution: uuid ou id curto (letras, números, _ e -). */
export const LN_PATIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function lnPatientUrl(base: string | null, lnPatientId: string | null): string | null {
  if (!base || !lnPatientId || !LN_PATIENT_ID.test(lnPatientId)) return null;
  return `${base}/pacientes/${encodeURIComponent(lnPatientId)}`;
}

/**
 * Senha central (acesso LN Medicina Integrada). Só existe com o login único ligado
 * (GOTRUE_URL + GOTRUE_ANON_KEY + GOTRUE_JWT_SECRET). Os links saem de GOTRUE_PUBLIC_APP_URL;
 * vazia ou inválida, o aviso aparece sem link.
 */
export type CentralPasswordLinks = { settings: string | null; recover: string | null };

export function centralPasswordLinks(raw: string | undefined = process.env.GOTRUE_PUBLIC_APP_URL): CentralPasswordLinks | null {
  if (!gotruePasswordConfigured()) return null;
  const base = publicHttpBase(raw);
  return { settings: base ? `${base}/configuracoes` : null, recover: base ? `${base}/recuperar-senha` : null };
}
