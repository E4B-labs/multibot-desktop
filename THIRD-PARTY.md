# Third-party components

MultiBot itself is licensed under the terms in [LICENSE](LICENSE). The Windows
desktop installer additionally ships the binaries listed below, unmodified.

## Upstream

Based on OpenMausBot (MIT). The MIT license requires the original copyright
notice to travel with the code, so it stays verbatim in [LICENSE](LICENSE);
this is the only place the upstream name is kept.

## Tor

`tor.exe` comes from the **Tor Expert Bundle 15.0.21** (tor 0.4.9.11),
Windows x86_64, downloaded and SHA-256 verified by
`scripts/fetch-tor.mjs` from
<https://archive.torproject.org/tor-package-archive/torbrowser/15.0.21/>.

The binary is shipped **unmodified and unrenamed**. Everything else in the
bundle is left out — pluggable transports (`lyrebird`, `conjure-client`),
`tor-gencert`, the docs and the `geoip`/`geoip6` databases — because MultiBot
only ever runs a plain client and onion service.
Source for the exact build is at <https://gitlab.torproject.org/tpo/core/tor>.

"Tor" and the Onion Logo are registered trademarks of The Tor Project, Inc.
MultiBot is not affiliated with, endorsed by, or sponsored by The Tor Project.

### License of this particular build — GPL-3.0-or-later

Tor's own source is 3-clause BSD (text below), but **the Expert Bundle binary is
not BSD-only**. It is built with `--enable-gpl`, which links the proof-of-work
defense (`equix` / `hashx`, GPL-licensed), so the binary as distributed is
covered by the **GNU General Public License, version 3 or later**. `tor.exe
--version` says so itself:

```
Tor version 0.4.9.11 (git-f3d28b2e0978ca07).
This build of Tor is covered by the GNU General Public License
(https://www.gnu.org/licenses/gpl-3.0.en.html)
```

We therefore ship it as a separate, unmodified executable in the installer's
resources — never linked into or derived from MultiBot's own code — and the
corresponding source for exactly this build is the upstream tag it was built
from, published by The Tor Project at
<https://gitlab.torproject.org/tpo/core/tor> (commit `f3d28b2e0978ca07`) with
the build recipe in <https://gitlab.torproject.org/tpo/applications/tor-browser-build>.
GPL text: <https://www.gnu.org/licenses/gpl-3.0.en.html>.

### Tor source license (3-clause BSD)

```
Copyright (c) 2001-2004, Roger Dingledine
Copyright (c) 2004-2006, Roger Dingledine, Nick Mathewson
Copyright (c) 2007-2019, The Tor Project, Inc.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.

    * Neither the names of the copyright owners nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

`tor.exe` statically links further components with their own terms — OpenSSL
(Apache-2.0), zlib, libevent (3-clause BSD), Trunnel, and others. The complete
notice for the exact build we ship is `docs/tor.txt` inside the Expert Bundle
archive named above; OpenSSL, zlib and libevent have their own files next to
it (`docs/openssl.txt`, `docs/zlib.txt`, `docs/libevent.txt`).

### Not bundled elsewhere

macOS and Linux use a `tor` installed by the system package manager
(`brew install tor`, `apt install tor`), so no Tor binary is redistributed with
those builds.

## Logotypy katalogu wtyczek

`src/lib/appIcons.ts` (i jego kopia w repo mobilnym, `webui/src/lib/appIcons.ts`)
niesie po jednym zminifikowanym, pełnokolorowym `<svg>` na każdą aplikację
z katalogu. Znaki są wklejone do repo, a nie ściągane z sieci: interfejs na
telefonie jedzie w paczce aplikacji i nie ma jak pobrać ikony z CDN-u.

Źródła, z których pochodzą poszczególne znaki:

| Źródło | Licencja | Czego dotyczy |
| --- | --- | --- |
| [gilbarbara/logos](https://github.com/gilbarbara/logos) (przez `@iconify-json/logos`) | **CC0-1.0** | większość znaków wielokolorowych — Gmail, Slack, Figma, GitLab, Airtable, Trello i pozostałe |
| [svgl](https://github.com/pheralb/svgl) | **MIT** | Outlook, Google Sheets, Canva, Instagram, Webflow, OpenRouter, Groq, Replicate, Firecrawl, Gemini, Hugging Face, Runway |
| [vectorlogo.zone](https://www.vectorlogo.zone/) | znaki publikowane do użytku nominatywnego | Salesforce, HubSpot, Intercom, BigQuery |
| oficjalne pliki marek | — | Apify (`apify.com`), Higgsfield (`higgsfield.ai`) |
| [simple-icons](https://github.com/simple-icons/simple-icons) | **CC0-1.0** | marki jednokolorowe — Google Docs, Calendly, Make, Mixpanel, Stripe; ścieżka dostaje firmowy hex podawany przez simple-icons |

CC0-1.0 to domena publiczna i atrybucja jest nieobowiązkowa — podajemy ją,
bo tak wypada.

**Znaki towarowe pozostają własnością odpowiednich firm.** Żadna z powyższych
licencji nie dotyczy samych znaków towarowych, tylko plików SVG. MultiBot
używa logotypów wyłącznie nominatywnie: żeby nazwać i pokazać usługę, którą
użytkownik sam podłącza. Nie sugerują one żadnego związku, sponsoringu ani
poparcia ze strony właścicieli marek. Właściciel marki, który sobie tego nie
życzy, może to zgłosić — znak zostanie zastąpiony monogramem.
