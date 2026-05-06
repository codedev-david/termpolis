# Termpolis Terms of Use

_Last updated: 2026-05-05_

Thanks for trying Termpolis. These terms govern your use of the Termpolis
desktop application and the source code published at
<https://github.com/codedev-david/termpolis>. By installing or using the app you
agree to them.

## 1. License

Termpolis is released under the Apache License, Version 2.0, reproduced in
the `LICENSE` file at the root of the repository. Attribution notices are in
the `NOTICE` file. In particular:

- You may use, copy, modify, and redistribute Termpolis, including in
  commercial products and proprietary derivative works.
- You must retain the copyright notice, the `LICENSE` file, and the `NOTICE`
  file in any substantial redistribution, and clearly mark any files you
  modify.
- Apache 2.0 includes an explicit patent license grant from contributors to
  users, and a defensive termination clause: if you sue anyone over patents
  you claim are infringed by Termpolis, your patent license terminates.
- **The software is provided "as is", without warranty of any kind.** See
  section 5 below.

## 2. Third-party tools

Termpolis is a frame around tools you already run — shells, AI coding agents
(Claude Code, Codex, Gemini CLI, Qwen Code), compilers, git, your own scripts. Your
use of those tools is governed by their own licenses and terms of service,
not these terms. Termpolis does not endorse or make guarantees about any
third-party tool.

## 3. Your responsibility

You are responsible for:

- What you run inside Termpolis terminals. Commands execute with the
  privileges of the user running the app.
- Any data you send to AI models or other cloud services from those
  terminals.
- Keeping API keys, credentials, and tokens secure. Termpolis does not
  manage, encrypt, or transmit your credentials; if you paste a key into a
  terminal it is treated like any other terminal input.

Do not use Termpolis to violate the law, the rights of others, or the terms
of service of a third-party tool you are launching from inside it.

## 4. Auto-updates

Termpolis checks for and downloads new signed releases from GitHub in the
background. Installed updates replace the existing binary. If you prefer to
control when updates install, you can dismiss the update banner and continue
running the existing version, or uninstall and re-install a specific release.

## 5. Disclaimer of warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## 5a. AI Security Center — scope and limits

Termpolis ships an in-app **AI Security Center** (Settings → Security) with
the goal of giving administrators visibility into outbound AI traffic.
**These features are best-effort, not regulatory-grade controls.** In
particular:

- The **per-agent training-disposition facts** displayed in the panel are
  summaries of public provider Terms of Service as of the build date.
  Provider terms can change without notice. Termpolis does not, and cannot,
  guarantee that any third-party AI provider (Anthropic, OpenAI, Google,
  Alibaba/DashScope, Ollama, or any future provider) will honor the data-
  handling commitments described. **You must verify provider terms via the
  links provided before transmitting confidential data.**
- The **redaction scanner** uses regular expressions targeted at well-shaped
  secrets (AWS keys, GitHub PATs, OpenAI/Anthropic/Google keys, JWTs, PEM
  private keys, `.env`-style assignments). It is **not** a comprehensive Data
  Loss Prevention (DLP) solution. Custom or unusual secret formats — including
  many internal corporate tokens — will not be detected.
- The **audit log** records what Termpolis observes locally. It does not
  capture activity that bypasses Termpolis (for example, an AI agent run
  from a separate native terminal window or a different application).
- **Strict Mode** for Gemini intercepts shell-level invocations of the
  `gemini` binary. It does not block out-of-band paths (a different binary
  name, a script that invokes the underlying Google API directly, etc.).

To the maximum extent permitted by law, the authors and contributors of
Termpolis disclaim all liability for any data leak, breach, regulatory
violation, contractual breach, or business loss arising from your use of any
AI agent launched through this application — including but not limited to:
use of free-tier AI accounts that send prompts to provider training
pipelines; use of corporate code under personal AI accounts; misconfiguration
of provider-side data controls; reliance on the redaction scanner for
secrets it does not detect; or any other circumstance covered by section 5
above.

## 6. Privacy

Privacy practices are documented separately in `PRIVACY.md`. In short:
Termpolis itself does not transmit your data anywhere unless you opt in to
crash reporting. AI agents you launch from Termpolis (Claude Code, Codex,
Gemini CLI, Qwen Code) communicate directly with their respective providers
under those providers' own privacy terms — Termpolis is the local terminal
host, not a privacy shield over those agents.

## 7. Changes to these terms

We will update the "Last updated" date at the top of this file when the terms
change. Material changes will be announced in the release notes for the
version that introduces them. Continued use of the app after a change
constitutes acceptance of the revised terms.

## 8. Contact

Questions can be filed as a GitHub issue at
<https://github.com/codedev-david/termpolis/issues>.
