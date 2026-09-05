# Termpolis Terms of Use

_Last updated: 2026-09-05_

Thanks for trying Termpolis. These terms govern your use of the Termpolis
desktop application, the **Termpolis Remote** companion app for iPhone and
Android, the **pairing relay** those two use to reach each other, and the
source code for all three published at
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
(Claude Code, Codex, Gemini CLI), compilers, git, your own scripts. Your
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
  Ollama, or any future provider) will honor the data-
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

## 5b. Termpolis Remote and the pairing relay — scope and limits

**Termpolis Remote** is a companion app that reads and types into terminals
already running on a Termpolis desktop. It is a remote control, not a second
Termpolis: it runs no agent and holds no credentials, and anything it asks for
is executed by your desktop, under your account, on your machine. **You remain
responsible for what is run**, exactly as in section 3 — a command typed from
a phone is a command you ran.

The **pairing relay** (`relay.termpolis.com` by default) is a service we
operate to introduce two devices that are usually on different networks. Using
it, you accept that:

- **It is provided as is, with no uptime commitment.** It may be rate limited,
  restarted, moved or withdrawn without notice, and we are not liable for work
  interrupted because a phone could not reach a desktop. The relay address is
  a setting: the relay is Apache-2.0 source in `relay/`, and you may run your
  own.
- **It carries ciphertext only.** Traffic is encrypted end to end between your
  two devices; we cannot read it, and we do not store it. That also means we
  cannot recover it, replay it, or help you get back a session you lost.
- **Turning Remote on is a decision about your own exposure.** Off by default,
  it puts a network path to your terminals in the hands of whoever holds the
  paired phone. Grant only the capabilities you need — typing into an existing
  terminal deliberately is *not* implied by creating one — verify the eight
  pairing words on both screens, and revoke a device you no longer control.
- **Do not use the relay to carry traffic other than Termpolis Remote's**, to
  attack or overload it, or to route another product's data through it.

## 6. Privacy

Privacy practices are documented separately in `PRIVACY.md`, and the combined
policy covering the desktop app, the phone app and the relay is published at
<https://termpolis.com/privacy.html>. In short:
Termpolis itself does not transmit your data anywhere unless you opt in to
crash reporting or turn on Termpolis Remote — and Remote's traffic is
end-to-end encrypted between your own two devices. AI agents you launch from Termpolis (Claude Code, Codex,
Gemini CLI) communicate directly with their respective providers
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
