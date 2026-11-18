/**
 * Faixas padrão por exame: normalidade laboratorial usual em adultos e alvo
 * "ótimo" como usado em nutrologia / medicina funcional. Pesquisa de nov/2026
 * (SBEM/SBPC-ML para 25(OH)D; Diretriz Brasileira de Dislipidemias; Lamkin
 * Clinic, Kresser Institute, OptimalDX, Vitalix para alvos funcionais). São
 * PONTOS DE PARTIDA para o médico revisar; onde a faixa depende do kit, da
 * idade ou da fase do ciclo, não há valor e a linha fica em rascunho.
 *
 * Formato: [normal_min, normal_max, otimo_min, otimo_max, critico_baixo, critico_alto]
 */
export type Band = [number | null, number | null, number | null, number | null, number | null, number | null];
export interface Defaults {
  all?: Band;
  F?: Band;
  M?: Band;
  /** desativa a linha "todos" quando só faz sentido por sexo */
  sexOnly?: boolean;
  text?: string;
}

export const REFERENCE_SOURCE = 'Pesquisa NutroLab nov/2026: referência laboratorial usual + alvo de nutrologia/funcional (SBEM-SBPC vit. D; Diretriz Dislipidemias SBC; Lamkin, Kresser, OptimalDX). Conferir e ajustar.';

export const REFERENCE_DEFAULTS: Record<string, Defaults> = {
  // metabolismo glicídico
  glicose_jejum: { all: [70, 99, 75, 90, 50, 400] },
  insulina_jejum: { all: [2.6, 24.9, 2, 8, null, null] },
  hba1c: { all: [null, 5.6, null, 5.3, null, 10] },
  homa_ir: { all: [null, 2.7, null, 1.5, null, null] },
  peptideo_c: { all: [1.1, 4.4, 1.1, 3.0, null, null] },
  frutosamina: { all: [205, 285, 205, 270, null, null] },
  glicose_pos_prandial: { all: [null, 140, null, 120, null, 300] },
  // lipídico / cardiovascular
  colesterol_total: { all: [null, 190, 120, 180, null, null] },
  hdl: { all: [40, null, 50, null, 20, null], F: [50, null, 60, null, 20, null], M: [40, null, 50, null, 20, null] },
  ldl: { all: [null, 130, null, 100, null, 250] },
  vldl: { all: [null, 30, null, 20, null, null] },
  colesterol_nao_hdl: { all: [null, 160, null, 130, null, null] },
  triglicerideos: { all: [null, 150, null, 100, null, 500] },
  apolipoproteina_a1: { all: [110, 205, 140, 205, null, null] },
  apolipoproteina_b: { all: [null, 130, null, 80, null, null] },
  lipoproteina_a: { all: [null, 50, null, 30, null, null] },
  homocisteina: { all: [5, 15, 5, 8, null, 30] },
  ck: { all: [null, 190, 30, 150, null, 1000] },
  ldh: { all: [120, 246, 120, 200, null, null] },
  fibrinogenio: { all: [200, 400, 200, 300, null, null] },
  indice_omega3: { all: [4, null, 8, 12, null, null] },
  // tireoide
  tsh: { all: [0.4, 4.5, 0.5, 2.5, 0.01, 10] },
  t4_livre: { all: [0.8, 1.8, 1.0, 1.6, null, null] },
  t4_total: { all: [4.5, 12, 6, 10, null, null] },
  t3_livre: { all: [2.3, 4.2, 3.0, 4.0, null, null] },
  t3_total: { all: [80, 200, 100, 180, null, null] },
  t3_reverso: { all: [10, 24, 10, 18, null, null] },
  anti_tpo: { all: [null, 34, null, 9, null, null] },
  anti_tireoglobulina: { all: [null, 115, null, 40, null, null] },
  trab: { all: [null, 1.75, null, 1.0, null, null] },
  tireoglobulina: { all: [1.4, 78, null, null, null, null] },
  // hematologia
  hemoglobina: { all: [12, 17.5, 13, 15.5, 7, 20], F: [12, 15.5, 13, 15, 7, 20], M: [13.5, 17.5, 14, 16.5, 7, 20] },
  hematocrito: { all: [36, 52, 38, 48, null, null], F: [36, 46, 38, 44, null, null], M: [41, 53, 42, 50, null, null] },
  hemacias: { all: [4, 5.9, 4.2, 5.6, null, null], F: [4.0, 5.2, 4.2, 5.0, null, null], M: [4.5, 5.9, 4.7, 5.6, null, null] },
  vcm: { all: [80, 100, 85, 95, null, null] },
  hcm: { all: [27, 33, 28, 32, null, null] },
  chcm: { all: [32, 36, 33, 35.5, null, null] },
  rdw: { all: [11.5, 14.5, 11.5, 13.5, null, null] },
  leucocitos: { all: [4000, 11000, 4500, 8500, 2000, 30000] },
  neutrofilos: { all: [1500, 7000, 1800, 5500, 1000, null] },
  linfocitos: { all: [1000, 4000, 1200, 3500, null, null] },
  monocitos: { all: [100, 1000, 200, 700, null, null] },
  eosinofilos: { all: [0, 500, 0, 300, null, null] },
  plaquetas: { all: [150000, 450000, 175000, 350000, 50000, 1000000] },
  reticulocitos: { all: [0.5, 2, 0.5, 1.5, null, null] },
  // ferro
  ferritina: { all: [30, 400, 50, 150, 10, 1000], F: [30, 200, 50, 120, 10, 1000], M: [30, 400, 70, 200, 10, 1000] },
  ferro_serico: { all: [50, 170, 60, 150, null, null] },
  transferrina: { all: [200, 360, 220, 330, null, null] },
  tibc: { all: [250, 450, 250, 400, null, null] },
  saturacao_transferrina: { all: [20, 45, 25, 40, null, null] },
  // vitaminas
  vitamina_a: { all: [30, 80, 40, 70, null, null] },
  vitamina_b1: { all: [70, 180, 90, 180, null, null] },
  vitamina_b6: { all: [8.7, 27.2, 12, 27.2, null, null] },
  folato: { all: [4, 20, 8, 20, null, null] },
  folato_eritrocitario: { all: [140, 628, 300, 628, null, null] },
  vitamina_b12: { all: [200, 900, 500, 900, 150, null] },
  acido_metilmalonico: { all: [null, 270, null, 250, null, null] },
  holotranscobalamina: { all: [35, null, 50, null, null, null] },
  vitamina_c: { all: [0.4, 2, 0.9, 2, null, null] },
  vitamina_d_25oh: { all: [20, 60, 40, 60, 10, 100] },
  vitamina_d_125: { all: [20, 80, 30, 70, null, null] },
  vitamina_e: { all: [5.5, 17, 9, 17, null, null] },
  coenzima_q10: { all: [0.5, 1.7, 0.8, 1.7, null, null] },
  // minerais e eletrólitos
  sodio: { all: [135, 145, 137, 143, 125, 155] },
  potassio: { all: [3.5, 5.1, 4.0, 4.8, 2.8, 6.0] },
  cloro: { all: [98, 107, 100, 105, null, null] },
  calcio_total: { all: [8.5, 10.5, 9.0, 10.0, 7, 12] },
  calcio_ionico: { all: [4.5, 5.3, 4.7, 5.2, null, null] },
  magnesio: { all: [1.7, 2.4, 2.0, 2.4, 1.2, 3.5] },
  magnesio_eritrocitario: { all: [4.2, 6.8, 5.5, 6.5, null, null] },
  fosforo: { all: [2.5, 4.5, 3.0, 4.0, null, null] },
  zinco: { all: [70, 120, 90, 120, null, null] },
  cobre: { all: [70, 140, 80, 120, null, null] },
  ceruloplasmina: { all: [20, 60, 20, 40, null, null] },
  selenio: { all: [70, 150, 110, 150, null, null] },
  iodo_urinario: { all: [100, 299, 100, 199, null, null] },
  manganes: { all: [4, 15, 4, 12, null, null] },
  // renal
  creatinina: { all: [0.6, 1.2, 0.7, 1.0, null, 3], F: [0.5, 1.0, 0.6, 0.9, null, 3], M: [0.7, 1.3, 0.8, 1.1, null, 3] },
  ureia: { all: [15, 45, 15, 40, null, null] },
  acido_urico: { all: [2.5, 7, 3.5, 5.5, null, 10], F: [2.5, 6, 3.0, 5.0, null, 10], M: [3.5, 7.2, 3.5, 6.0, null, 10] },
  tfg_estimada: { all: [90, null, 90, null, 30, null] },
  cistatina_c: { all: [0.5, 1.0, 0.5, 0.9, null, null] },
  microalbuminuria: { all: [null, 30, null, 15, null, null] },
  // hepático
  tgo: { all: [null, 40, null, 30, null, 200], F: [null, 35, null, 25, null, 200], M: [null, 40, null, 30, null, 200] },
  tgp: { all: [null, 41, null, 30, null, 200], F: [null, 33, null, 25, null, 200], M: [null, 41, null, 33, null, 200] },
  ggt: { all: [null, 60, null, 30, null, null], F: [null, 40, null, 20, null, null], M: [null, 60, null, 30, null, null] },
  fosfatase_alcalina: { all: [40, 130, 45, 100, null, null] },
  bilirrubina_total: { all: [null, 1.2, 0.2, 1.0, null, null] },
  bilirrubina_direta: { all: [null, 0.3, null, 0.2, null, null] },
  albumina: { all: [3.5, 5.2, 4.2, 5.0, null, null] },
  proteinas_totais: { all: [6, 8, 6.5, 7.8, null, null] },
  amilase: { all: [28, 100, 28, 90, null, null] },
  lipase: { all: [13, 60, 13, 50, null, null] },
  // inflamação / imunidade
  pcr: { all: [null, 3, null, 1, null, 50] },
  vhs: { all: [null, 20, null, 10, null, null], F: [null, 20, null, 15, null, null], M: [null, 15, null, 10, null, null] },
  interleucina_6: { all: [null, 7, null, 3, null, null] },
  anti_transglutaminase: { all: [null, 20, null, 20, null, null] },
  iga_total: { all: [70, 400, 100, 350, null, null] },
  // hormônios
  testosterona_total: { sexOnly: true, M: [300, 1000, 500, 900, null, null], F: [15, 70, 25, 60, null, null] },
  shbg: { all: [18, 144, 25, 80, null, null] },
  estradiol: { sexOnly: true, M: [10, 40, 20, 35, null, null] },
  prolactina: { all: [null, 25, 5, 20, null, null], F: [null, 25, 5, 20, null, null], M: [null, 20, 5, 15, null, null] },
  dhea_s: { sexOnly: true, F: [35, 430, 150, 350, null, null], M: [80, 560, 200, 450, null, null] },
  cortisol: { all: [5, 25, 10, 18, 3, null] },
  acth: { all: [7, 63, 10, 50, null, null] },
  aldosterona: { all: [null, 30, 4, 20, null, null] },
  androstenediona: { all: [0.3, 3.3, 0.5, 2.5, null, null] },
  // ósseo
  pth: { all: [15, 65, 20, 50, null, null] },
  calciuria_24h: { all: [100, 300, 100, 250, null, null] },
  // urina
  sodio_urinario_24h: { all: [40, 220, 40, 150, null, null] },
  // outros
  hbsag: { text: 'não reagente' },
  anti_hcv: { text: 'não reagente' },
  anti_hiv: { text: 'não reagente' },
  vdrl: { text: 'não reagente' },
  psa_total: { sexOnly: true, M: [null, 4, null, 2.5, null, 10] },
  beta_hcg: { all: [null, 5, null, 5, null, null] },
};
