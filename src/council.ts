/**
 * Verificação no conselho profissional (CRM/CRN).
 * Ainda não implementada por decisão do médico: hoje devolve "nao_verificado".
 * Quando for implementada, consultar o portal do conselho (CFM/CRN) e registrar
 * o resultado em users.council_verified_at.
 */
export type CouncilCheck = { status: 'nao_verificado' | 'verificado' | 'nao_encontrado'; detail: string };

export async function verifyCouncil(_council: string, _number: string, _state: string): Promise<CouncilCheck> {
  return { status: 'nao_verificado', detail: 'verificação automática no conselho ainda não ativada' };
}
