"""Cliente HTTP educado: timeout, user-agent genérico e intervalo por domínio."""
from __future__ import annotations

import time
from urllib.parse import urlparse

import requests

from .site import USER_AGENT


class Http:
    def __init__(self, intervalo: float = 1.0, timeout: float = 15.0):
        self.sessao = requests.Session()
        self.sessao.headers["User-Agent"] = USER_AGENT
        self.intervalo = intervalo
        self.timeout = timeout
        self._ultimo: dict[str, float] = {}

    def _esperar(self, url: str) -> None:
        host = urlparse(url).netloc
        espera = self._ultimo.get(host, 0) + self.intervalo - time.monotonic()
        if espera > 0:
            time.sleep(espera)
        self._ultimo[host] = time.monotonic()

    def get(self, url: str, **kw):
        self._esperar(url)
        try:
            return self.sessao.get(url, timeout=self.timeout, **kw)
        except requests.RequestException:
            return None

    def post(self, url: str, **kw):
        self._esperar(url)
        try:
            return self.sessao.post(url, timeout=self.timeout, **kw)
        except requests.RequestException:
            return None
