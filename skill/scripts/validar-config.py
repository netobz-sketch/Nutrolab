#!/usr/bin/env python3
"""Valida a configuração clínica da skill analisar-exames-nutrologia.

Usa apenas a biblioteca padrão. Saída: resumo, erros e avisos.
Código de saída 1 quando houver erro.
"""
import csv
import datetime
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "references" / "valores-otimizados.csv"
ORIENT_PATH = ROOT / "references" / "orientacoes-aprovadas.md"
ESQUEMA_PATH = ROOT / "references" / "esquema-tabela.md"
CALC_PATH = ROOT / "references" / "calculos-derivados.md"

COLS = [
    "exame_canonico", "aliases", "sexo", "idade_min", "idade_max", "contexto",
    "unidade", "alvo_min", "alvo_max", "alvo_texto", "limite_critico_inferior",
    "limite_critico_superior", "orientacao_id", "fonte_clinica", "versao",
    "data_revisao", "status",
]
STATUS = {"ativo", "rascunho", "inativo"}
SEXO = {"M", "F", "todos"}
ORIENT_FIELDS = [
    "orientacao_id", "titulo", "aplica_quando", "nao_aplicar_quando",
    "texto_paciente", "exige_alerta", "fonte_clinica", "versao",
    "data_revisao", "status",
]
TEMPLATE_ID = "ORIENTACAO-ID-UNICO"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def is_date(value):
    if not DATE_RE.match(value or ""):
        return False
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True
SNAKE_RE = re.compile(r"^[a-z0-9_]+$")
ORIENT_ID_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]*$")

errors = []
warnings = []


def err(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def is_decimal(value):
    return re.match(r"^-?\d+(\.\d+)?$", value) is not None


def is_int(value):
    return re.match(r"^\d+$", value) is not None


# ---------- leitura de blocos YAML simples dentro de Markdown ----------

def yaml_blocks(text):
    return re.findall(r"```yaml\n(.*?)```", text, flags=re.S)


def unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        return [v.strip() for v in inner.split(",")] if inner else []
    return value


def parse_items(block):
    """Lê uma lista YAML plana: '- chave: valor' e '  chave: valor'.

    Linhas mais indentadas que a chave são tratadas como continuação do valor.
    """
    items = []
    current = None
    current_key = None
    key_indent = None
    for raw in block.splitlines():
        if not raw.strip() or raw.strip().startswith("#"):
            continue
        m = re.match(r"^(\s*)(- )?([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$", raw)
        indent = len(raw) - len(raw.lstrip(" "))
        if m and m.group(2):
            current = {}
            items.append(current)
            key_indent = indent + 2
            current_key = m.group(3)
            current[current_key] = unquote(m.group(4) or "")
            continue
        if m and current is not None and indent <= (key_indent or 0):
            current_key = m.group(3)
            current[current_key] = unquote(m.group(4) or "")
            continue
        if current is not None and current_key is not None:
            prev = current[current_key]
            if isinstance(prev, str):
                current[current_key] = (prev + " " + raw.strip()).strip()
    return items


# ---------- vocabulário de contexto (fonte única: esquema-tabela.md) ----------

def load_contexts():
    if not ESQUEMA_PATH.exists():
        err(f"arquivo ausente: {ESQUEMA_PATH.name}")
        return set()
    text = ESQUEMA_PATH.read_text(encoding="utf-8")
    section = text.split("## Vocabulário de `contexto`", 1)
    if len(section) < 2:
        err("esquema-tabela.md: seção 'Vocabulário de `contexto`' não encontrada")
        return set()
    body = section[1].split("\n## ", 1)[0]
    found = set(re.findall(r"^\| `([a-z_]+)` \|", body, flags=re.M))
    if not found:
        err("esquema-tabela.md: vocabulário de contexto vazio")
    return found


# ---------- orientações ----------

def load_orientacoes():
    if not ORIENT_PATH.exists():
        err(f"arquivo ausente: {ORIENT_PATH.name}")
        return {}
    text = ORIENT_PATH.read_text(encoding="utf-8")
    result = {}
    for block in yaml_blocks(text):
        for item in parse_items(block):
            oid = item.get("orientacao_id", "")
            if oid == TEMPLATE_ID:
                continue
            label = f"orientação '{oid or '?'}'"
            for field in ORIENT_FIELDS:
                if field not in item or item[field] in ("", None):
                    err(f"{label}: campo obrigatório vazio: {field}")
            if oid in result:
                err(f"{label}: orientacao_id duplicado")
            if oid and not ORIENT_ID_RE.match(oid):
                err(f"{label}: id deve ser MAIÚSCULAS, dígitos e hífens")
            if item.get("status") not in STATUS:
                err(f"{label}: status inválido '{item.get('status')}'")
            if item.get("exige_alerta") not in ("true", "false"):
                err(f"{label}: exige_alerta deve ser true ou false")
            if not is_date(item.get("data_revisao", "")):
                err(f"{label}: data_revisao inválida (use AAAA-MM-DD com data real)")
            result[oid] = item
    return result


# ---------- cálculos derivados ----------

def load_calculos():
    if not CALC_PATH.exists():
        warn(f"arquivo ausente: {CALC_PATH.name}")
        return {}
    text = CALC_PATH.read_text(encoding="utf-8")
    result = {}
    for block in yaml_blocks(text):
        for item in parse_items(block):
            cid = item.get("id", "")
            label = f"cálculo '{cid or '?'}'"
            if not cid or not SNAKE_RE.match(cid):
                err(f"{label}: id deve ser snake_case")
            if cid in result:
                err(f"{label}: id duplicado")
            if item.get("status") not in STATUS:
                err(f"{label}: status inválido '{item.get('status')}'")
            for field in ("nome", "formula", "unidade", "insumos", "condicoes"):
                if not item.get(field):
                    err(f"{label}: campo vazio: {field}")
            result[cid] = item
    return result


# ---------- tabela de alvos ----------

def load_rows():
    if not CSV_PATH.exists():
        err(f"arquivo ausente: {CSV_PATH.name}")
        return []
    with CSV_PATH.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        header = reader.fieldnames or []
        if header != COLS:
            err(
                "valores-otimizados.csv: cabeçalho diferente do esperado.\n"
                f"    esperado: {','.join(COLS)}\n    lido:     {','.join(header)}"
            )
            return []
        rows = []
        for n, row in enumerate(reader, start=2):
            row = {k: (v or "").strip() for k, v in row.items()}
            row["_linha"] = n
            rows.append(row)
        return rows


def validate_rows(rows, contexts, orientacoes, calculos):
    seen = {}
    for row in rows:
        n = row["_linha"]
        name = row["exame_canonico"]
        label = f"csv linha {n} ({name or '?'})"
        if not SNAKE_RE.match(name):
            err(f"{label}: exame_canonico deve ser snake_case sem acento")
        if row["status"] not in STATUS:
            err(f"{label}: status inválido '{row['status']}'")
        if row["sexo"] not in SEXO:
            err(f"{label}: sexo deve ser M, F ou todos")
        for col in ("idade_min", "idade_max"):
            if row[col] and not is_int(row[col]):
                err(f"{label}: {col} deve ser inteiro em anos")
        if is_int(row["idade_min"]) and is_int(row["idade_max"]) and int(row["idade_min"]) > int(row["idade_max"]):
            err(f"{label}: idade_min maior que idade_max")
        if not row["contexto"]:
            err(f"{label}: contexto vazio (use 'geral')")
        for ctx in filter(None, row["contexto"].split("|")):
            if ctx not in contexts:
                err(f"{label}: contexto '{ctx}' fora do vocabulário de esquema-tabela.md")
        if not row["unidade"]:
            err(f"{label}: unidade vazia")
        for col in ("alvo_min", "alvo_max", "limite_critico_inferior", "limite_critico_superior"):
            if row[col] and not is_decimal(row[col]):
                err(f"{label}: {col} deve ser decimal com ponto")
        if not (row["alvo_min"] or row["alvo_max"] or row["alvo_texto"]):
            err(f"{label}: preencha alvo_min, alvo_max ou alvo_texto")
        if is_decimal(row["alvo_min"]) and is_decimal(row["alvo_max"]) and float(row["alvo_min"]) > float(row["alvo_max"]):
            err(f"{label}: alvo_min maior que alvo_max")
        if is_decimal(row["limite_critico_inferior"]) and is_decimal(row["alvo_min"]) and float(row["limite_critico_inferior"]) > float(row["alvo_min"]):
            err(f"{label}: limite_critico_inferior acima de alvo_min")
        if is_decimal(row["limite_critico_superior"]) and is_decimal(row["alvo_max"]) and float(row["limite_critico_superior"]) < float(row["alvo_max"]):
            err(f"{label}: limite_critico_superior abaixo de alvo_max")
        if not row["fonte_clinica"]:
            err(f"{label}: fonte_clinica vazia")
        if not row["versao"]:
            err(f"{label}: versao vazia")
        if not is_date(row["data_revisao"]):
            err(f"{label}: data_revisao inválida (use AAAA-MM-DD com data real)")
        for oid in filter(None, row["orientacao_id"].split("|")):
            target = orientacoes.get(oid)
            if target is None:
                err(f"{label}: orientacao_id '{oid}' não existe em orientacoes-aprovadas.md")
            elif row["status"] == "ativo" and target.get("status") != "ativo":
                warn(f"{label}: regra ativa aponta para orientação '{oid}' com status {target.get('status')}; ela não será usada")
        if name in calculos and row["status"] == "ativo" and calculos[name].get("status") != "ativo":
            warn(f"{label}: alvo ativo para cálculo '{name}', mas o cálculo está {calculos[name].get('status')}")
        if row["status"] == "ativo" and row["fonte_clinica"].upper().startswith("EXEMPLO"):
            err(f"{label}: linha de exemplo marcada como ativa; substitua fonte_clinica pela fonte real")
        key = (name, row["sexo"], row["idade_min"], row["idade_max"], row["contexto"], row["unidade"])
        if row["status"] == "ativo":
            if key in seen:
                err(f"{label}: regra ativa duplicada da linha {seen[key]} (mesmo exame, sexo, idade, contexto e unidade)")
            seen[key] = n


def validate_orientacoes_usage(rows, orientacoes):
    used = set()
    for row in rows:
        if row["status"] == "ativo":
            used.update(filter(None, row["orientacao_id"].split("|")))
    for oid, item in orientacoes.items():
        if item.get("status") == "ativo" and oid not in used:
            warn(f"orientação ativa '{oid}' não é referenciada por nenhuma regra ativa")
        if item.get("status") == "ativo" and item.get("fonte_clinica", "").upper().startswith("EXEMPLO"):
            err(f"orientação '{oid}' de exemplo marcada como ativa; substitua fonte_clinica pela fonte real")


def main():
    contexts = load_contexts()
    orientacoes = load_orientacoes()
    calculos = load_calculos()
    rows = load_rows()
    validate_rows(rows, contexts, orientacoes, calculos)
    validate_orientacoes_usage(rows, orientacoes)

    def count(items, status):
        return sum(1 for i in items if i.get("status") == status)

    print("Resumo da configuração")
    print(f"  regras na tabela: {len(rows)} (ativas {count(rows, 'ativo')}, rascunho {count(rows, 'rascunho')}, inativas {count(rows, 'inativo')})")
    print(f"  orientações:      {len(orientacoes)} (ativas {count(orientacoes.values(), 'ativo')}, rascunho {count(orientacoes.values(), 'rascunho')})")
    print(f"  cálculos:         {len(calculos)} (ativos {count(calculos.values(), 'ativo')}, rascunho {count(calculos.values(), 'rascunho')})")
    print(f"  contextos válidos: {', '.join(sorted(contexts))}")
    active_dates = [r["data_revisao"] for r in rows if r.get("status") == "ativo" and is_date(r["data_revisao"])]
    versao = f"{max(active_dates)} ({len(active_dates)} regras ativas)" if active_dates else "sem regras ativas"
    print(f"  versão da tabela clínica: {versao}")
    if warnings:
        print(f"\nAvisos ({len(warnings)})")
        for w in warnings:
            print(f"  - {w}")
    if errors:
        print(f"\nErros ({len(errors)})")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("\nSem erros.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
