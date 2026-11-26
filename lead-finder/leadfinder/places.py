"""Busca de empresas pela API oficial do Google Places (Text Search, versão New).

Usa a API oficial em vez de raspar o Google Maps, como pedem os termos de uso.
Requer a variável de ambiente GOOGLE_MAPS_API_KEY.
"""
from __future__ import annotations

URL = "https://places.googleapis.com/v1/places:searchText"
CAMPOS = ",".join(
    [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.addressComponents",
        "places.nationalPhoneNumber",
        "places.websiteUri",
        "places.rating",
        "places.userRatingCount",
        "places.businessStatus",
        "nextPageToken",
    ]
)


def _bairro(componentes: list[dict]) -> str:
    for tipo in ("sublocality_level_1", "sublocality", "neighborhood"):
        for c in componentes or []:
            if tipo in c.get("types", []):
                return c.get("longText", "")
    return ""


def _municipio(componentes: list[dict]) -> str:
    for c in componentes or []:
        if "administrative_area_level_2" in c.get("types", []):
            return c.get("longText", "")
    return ""


def converter(lugar: dict, consulta: str) -> dict:
    comps = lugar.get("addressComponents") or []
    return {
        "place_id": lugar.get("id", ""),
        "empresa": (lugar.get("displayName") or {}).get("text", ""),
        "endereco": lugar.get("formattedAddress", ""),
        "bairro": _bairro(comps),
        "municipio_maps": _municipio(comps),
        "telefone": lugar.get("nationalPhoneNumber", ""),
        "site": lugar.get("websiteUri", ""),
        "nota": lugar.get("rating"),
        "avaliacoes": lugar.get("userRatingCount"),
        "consulta": consulta,
    }


def buscar(consulta: str, chave: str, http, maximo: int = 20) -> list[dict]:
    resultados: list[dict] = []
    token = None
    while len(resultados) < maximo:
        corpo = {
            "textQuery": consulta,
            "languageCode": "pt-BR",
            "regionCode": "BR",
            "pageSize": min(20, maximo - len(resultados)),
        }
        if token:
            corpo["pageToken"] = token
        resp = http.post(
            URL,
            json=corpo,
            headers={"X-Goog-Api-Key": chave, "X-Goog-FieldMask": CAMPOS},
        )
        if resp is None or resp.status_code != 200:
            detalhe = resp.text[:300] if resp is not None else "sem resposta"
            raise RuntimeError(f"Places API falhou para '{consulta}': {detalhe}")
        dados = resp.json()
        for lugar in dados.get("places", []):
            if lugar.get("businessStatus", "OPERATIONAL") == "OPERATIONAL":
                resultados.append(converter(lugar, consulta))
        token = dados.get("nextPageToken")
        if not token:
            break
    return resultados[:maximo]
