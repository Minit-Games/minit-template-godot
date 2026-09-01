extends Node
## Minit Games Godot SDK — core facade (prototype).
##
## A Godot game exported to HTML5 runs as a normal web page inside the Minit
## host, so it talks to the host-injected `window.minit` runtime directly via
## Godot's JavaScriptBridge — no bundler, no npm dependency, no CDN fetch. This
## mirrors the Unity / Defold / PlayCanvas SDKs: the GDScript API maps 1:1 to the
## same `window.minit` contract, so host behaviour is identical across engines.
##
## Outside the Minit host (editor, desktop build, or an HTML5 build opened with
## no host injecting `window.minit`) every call degrades gracefully: writes
## become a `print`, reads fall back to URL query params. Safe to call anywhere.
##
## Install: enable the plugin (Project → Project Settings → Plugins), which
## registers this file as the `Minit` autoload. Then call it from any script,
## e.g. `Minit.report_result(score)`.

## SDK version of this copy — compare against the KB article if you pasted it in.
const VERSION := "0.1.0"

const RESERVED_CONFIG_KEY := "userData"
const LOG_PREFIX := "[Minit]"

# JavaScriptBridge only functions in web exports. OS.has_feature("web") is the
# canonical "are we running on the web?" check — the analog of Defold's
# `html5 ~= nil`.
func _has_bridge() -> bool:
	return OS.has_feature("web")


## Signal the host the game is booted and ready to be revealed.
## The host keeps the game hidden until this fires.
func loading_done() -> void:
	if _has_bridge():
		JavaScriptBridge.eval("if(window.minit&&window.minit.loadingDone){window.minit.loadingDone();}else{console.log('[Minit] loadingDone');}")
	else:
		print(LOG_PREFIX, " loadingDone")


## Submit the final result. Call exactly once when the game ends.
## Higher score = better by default.
##
## options: {
##   flavor_text: String,  # short session caption for the host result screen / feed
##   delay:       int,      # ms the host waits before showing the result screen
##   user_data:   String,   # persist in this player's single userData slot;
##                          # omit to leave unchanged, "" is a valid write
## }
func report_result(score, options: Dictionary = {}) -> void:
	# Wrap user_data into { value } to match HostResultOptions / UserDataPatchSchema
	# in @minit/shared/zod. Games pass a bare string; the wrapping is a wire-format
	# detail.
	var host_options := {}
	if options.has("flavor_text"): host_options["flavorText"] = options["flavor_text"]
	if options.has("delay"):       host_options["delay"] = options["delay"]
	if options.has("user_data"):   host_options["userData"] = { "value": options["user_data"] }

	if _has_bridge():
		# JSON is valid JS, so we embed an object literal the browser eval reads
		# back. JSON.stringify guarantees valid escaping of strings/quotes.
		var payload := JSON.stringify({ "score": score, "options": host_options })
		var js := "(function(){var p=%s;if(window.minit&&window.minit.reportResult){window.minit.reportResult(p.score,p.options);}else{console.log('[Minit] reportResult',p.score,p.options);}})();" % payload
		JavaScriptBridge.eval(js)
	else:
		print(LOG_PREFIX, " reportResult ", score)


## Read a game config value from URL query parameters.
## Returns `default` when the key is absent or reserved. The `userData` key is
## reserved and always returns `default`.
func get_config_value(key: String, default: String = "") -> String:
	if key == RESERVED_CONFIG_KEY: return default
	if not _has_bridge(): return default

	# JSON.stringify distinguishes an absent param (JS null -> "null") from an
	# empty-but-present param (-> "\"\""). JSON.stringify(key) yields a valid JS
	# string literal so arbitrary keys can't break out of the expression.
	var key_literal := JSON.stringify(key)
	var raw = JavaScriptBridge.eval("JSON.stringify(new URLSearchParams(window.location.search).get(%s))" % key_literal)
	if typeof(raw) != TYPE_STRING or raw == "" or raw == "null": return default
	var val = JSON.parse_string(raw)
	return val if typeof(val) == TYPE_STRING else default


## Returns the single-slot userData string for this player, or null.
## Reads host-injected `window.minit.userData` directly (no JSON parsing of the
## value). Local-dev fallback: when the host has not injected userData, falls back
## to the `?userData=<value>` URL param. Returns "" if the stored value is the
## empty string (distinct from null).
func get_user_data():
	if not _has_bridge(): return null
	var raw = JavaScriptBridge.eval(
		"(function(){var v=window.minit&&window.minit.userData;" +
		"if(v===undefined||v===null){v=new URLSearchParams(window.location.search).get('userData');}" +
		"return JSON.stringify(v===null?null:v);})()")
	if typeof(raw) != TYPE_STRING or raw == "" or raw == "null": return null
	var val = JSON.parse_string(raw)
	return val if typeof(val) == TYPE_STRING else null
