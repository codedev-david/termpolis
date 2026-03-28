cask "termpolis" do
  version "1.4.1"
  sha256 "REPLACE_WITH_SHA256"

  url "https://github.com/codedev-david/termpolis/releases/download/v#{version}/Termpolis-#{version}.dmg"
  name "Termpolis"
  desc "AI-native terminal manager where Claude, Codex, Gemini, and Qwen work together"
  homepage "https://github.com/codedev-david/termpolis"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Termpolis.app"

  zap trash: [
    "~/Library/Application Support/Termpolis",
    "~/Library/Preferences/com.termpolis.app.plist",
    "~/Library/Saved Application State/com.termpolis.app.savedState",
  ]
end
