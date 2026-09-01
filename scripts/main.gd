extends Node2D
## Bouncy Ball -- the whole game, and a worked example of every Minit SDK call.
##
## Tap the ball to bounce it; each tap scores. A 30 second clock ends
## the run and reports the result. That is the entire game: it exists so the
## lifecycle around it is easy to read.
##
## WHAT TO COPY FROM HERE
##   * _read_config()        -- config values, with defaults and clamping
##   * Minit.loading_done()  -- at the end of _ready, once the scene is placed
##   * _finish()             -- report_result exactly once, with flavor text,
##                              persisted user_data and a delay for the outro
##   * the audio gate        -- _start_audio() and _audio_context_running()
##   * _layout()             -- no design surface; measured from the viewport

const FONT_PX := 52          ## reference size; every label scales from the unit

# Motion is expressed in layout units, not pixels, so the ball behaves the same
# on every viewport. Godot's Y axis points DOWN, so gravity is positive.
const GRAVITY := 30.0        ## units/s^2
const TAP_IMPULSE := 13.0    ## units/s, upward
const BOUNCE_DAMP := 0.62    ## energy kept on each landing
const REST_SPEED := 1.4      ## below this the ball stops rather than jittering
const END_DELAY_MS := 900    ## how long the host waits before its result screen

var _points_per_tap := 10
var _sound_on := true
var _music_on := true

var _score := 0
var _taps := 0
var _best: int = -1          ## -1 = no previous run recorded
const ROUND_SECONDS := 30.0   ## a drop is one session; the clock ends it, not a button

var _finished := false
var _remaining := ROUND_SECONDS
var _shown_second := 30
var _started := false        ## nothing plays before the first tap
var _music_started := false
var _music_retry := 0.0

var _vy := 0.0
var _ball_y := 0.0
var _squash := 0.0

# Layout, all rebuilt from the viewport in _layout().
var _unit := 1.0
var _ground_y := 0.0
var _ball_x := 0.0
var _ball_rest_y := 0.0
var _ball_r := 1.0
var _viewport := Vector2.ZERO

@onready var _turf_root: Node2D = $Turf


func _ready() -> void:
	_read_config()

	# The player's single persisted slot, written by report_result last run.
	var stored = Minit.get_user_data()
	if stored != null and str(stored) != "":
		_best = int(str(stored))

	# The music is a plain WAV, so looping is set here rather than in an import
	# preset. loop_end must be in FRAMES, not bytes.
	var stream := $Music.stream as AudioStreamWAV
	if stream != null:
		var bytes_per_sample := 2 if stream.format == AudioStreamWAV.FORMAT_16_BITS else 1
		var channels := 2 if stream.stereo else 1
		stream.loop_mode = AudioStreamWAV.LOOP_FORWARD
		stream.loop_begin = 0
		stream.loop_end = stream.data.size() / (bytes_per_sample * channels)

	$Music.volume_db = linear_to_db(0.45)
	$TapSfx.volume_db = linear_to_db(0.55)
	$BounceSfx.volume_db = linear_to_db(0.5)
	$FinishSfx.volume_db = linear_to_db(0.8)

	get_viewport().size_changed.connect(_layout)

	_layout()
	_ball_y = _ball_rest_y
	_refresh_score()
	$UI/Result.visible = false
	$UI/ResultLabel.visible = false
	$UI/Caption.visible = false

	# The scene is built and placed, so the host can reveal the game now.
	Minit.loading_done()


func _read_config() -> void:
	# Values arrive as strings from the post's URL query. Booleans follow the
	# backend's own coercion: anything other than "true" is false.
	var points := Minit.get_config_value("pointsPerTap", "10")
	_points_per_tap = clampi(int(points) if points.is_valid_int() else 10, 1, 100)
	_sound_on = Minit.get_config_value("sound", "true") != "false"
	_music_on = Minit.get_config_value("music", "true") != "false"


# ---------------------------------------------------------------------- layout

func _layout() -> void:
	_viewport = get_viewport_rect().size
	var w := _viewport.x
	var h := _viewport.y

	# Tracks the narrow axis but is capped against height, so a very wide slot
	# does not blow the art up past what fits vertically. The project's design
	# numbers are floors: canvas_items + expand means exactly one axis lands on
	# its design value and the other is larger.
	_unit = minf(w / 9.0, h / 18.0)

	_ground_y = h * 0.56          # screen Y grows downward
	_ball_r = _unit * 1.15
	_ball_x = w * 0.5
	_ball_rest_y = _ground_y - _ball_r

	$Sky.position = Vector2(w * 0.5, h * 0.5)
	$Sky.scale = Vector2(w / 8.0, h / 256.0)

	var soil := h - _ground_y
	$Ground.position = Vector2(w * 0.5, _ground_y + soil * 0.5)
	$Ground.scale = Vector2(w / 8.0, soil / 256.0)

	_build_turf(w)

	$UI/Dim.size = _viewport
	$UI/Dim.position = Vector2.ZERO

	_place_label($UI/Score, w * 0.5, minf(h * 0.11, _unit * 2.2), w * 0.8,
			_fit(str(_score), w * 0.6, _unit * 1.9))
	# The clock sits under the score, so both read as one HUD block. Rendered
	# as 0:24 rather than a bare number: stacked under the score with no label,
	# "24" under "20" reads as a second score.
	_place_label($UI/Timer, w * 0.5, minf(h * 0.11, _unit * 2.2) + _unit * 1.15, w * 0.8,
			_fit("0:00", w * 0.34, _unit * 0.8))
	_place_label($UI/Hint, w * 0.5, minf(h * 0.11, _unit * 2.2) + _unit * 2.2, w * 0.8,
			_fit("TAP THE BALL", w * 0.7, _unit * 0.5))

	if _finished:
		_place_result()


func _build_turf(w: float) -> void:
	# The grass fringe is TILED, not stretched. One sprite scaled to the full
	# width smears the blades into blobs; repeating it at a uniform scale keeps
	# them the same shape on every viewport.
	for child in _turf_root.get_children():
		child.queue_free()
	var tile_w := _unit * 1.7
	var tile_s := tile_w / 128.0
	var tile_h := 40.0 * tile_s
	var count := int(ceil(w / tile_w)) + 1
	var texture: Texture2D = load("res://assets/turf.png")
	for i in count:
		var s := Sprite2D.new()
		s.texture = texture
		s.scale = Vector2(tile_s, tile_s)
		s.position = Vector2((i + 0.5) * tile_w, _ground_y - tile_h * 0.15)
		_turf_root.add_child(s)


## Largest font size at which `text` still fits `max_width`, capped at `max_px`.
## Deliberately over-estimates the average advance, so text ends up slightly
## smaller than it had to be rather than clipped.
func _fit(text: String, max_width: float, max_px: float) -> float:
	return minf(max_px, max_width / maxf(1.0, float(text.length())) / 0.70)


func _place_label(label: Label, cx: float, cy: float, w: float, px: float) -> void:
	label.add_theme_font_size_override("font_size", int(px))
	label.add_theme_color_override("font_color", Color.WHITE)
	label.add_theme_color_override("font_outline_color", Color(0.125, 0.188, 0.227))
	label.add_theme_constant_override("outline_size", int(maxf(2.0, px * 0.14)))
	label.size = Vector2(w, px * 1.7)
	label.position = Vector2(cx - w * 0.5, cy - px * 0.85)


func _refresh_score() -> void:
	$UI/Score.text = str(_score)
	_place_label($UI/Score, _viewport.x * 0.5, minf(_viewport.y * 0.11, _unit * 2.2),
			_viewport.x * 0.8, _fit(str(_score), _viewport.x * 0.6, _unit * 1.9))


# ----------------------------------------------------------------------- audio

## Is the page's audio context actually running?
##
## Godot's web audio driver produces nothing useful while its AudioContext is
## suspended, so a loop started too early is simply lost. web/shell.html keeps a
## registry of contexts for exactly this question. Returns true off the web, and
## true when no context exists yet, so a caller polling this cannot deadlock.
func _audio_context_running() -> bool:
	if not OS.has_feature("web"):
		return true
	var result = JavaScriptBridge.eval("""
		(function () {
			var a = window.__minitAudioContexts;
			if (!a || !a.length) { return '1'; }
			for (var i = 0; i < a.length; i++) { if (a[i].state !== 'running') { return '0'; } }
			return '1';
		})()
	""", true)
	return not (typeof(result) == TYPE_STRING and result == "0")


func _play(player: AudioStreamPlayer) -> void:
	# Nothing plays before the first tap: that tap is also the gesture that lets
	# the browser (and the app's WebView) resume audio.
	if not _sound_on or not _started:
		return
	player.play()


func _try_start_music(delta: float) -> void:
	if _music_started or not _music_on or not _started:
		return
	_music_retry -= delta
	if _music_retry > 0.0:
		return
	_music_retry = 0.25          # the check crosses into JS; throttle it
	if _audio_context_running():
		$Music.play()
		_music_started = true


# -------------------------------------------------------------------- gameplay

func _process(delta: float) -> void:
	# The clock gets a looser cap than the physics below. Sharing the 0.05 cap
	# makes every slow frame quietly donate time back to the player, so a
	# 30 second round measurably overruns.
	var tick := minf(delta, 0.5)
	delta = minf(delta, 0.05)    # never let a stalled tab deliver one huge step
	_try_start_music(delta)

	# Counts from the moment the game is interactive, not from the first tap:
	# a run has to end on its own, or a player who never touches the ball never
	# produces a result at all.
	if not _finished:
		_remaining -= tick
		var whole := int(max(0.0, ceil(_remaining)))
		if whole != _shown_second:
			_shown_second = whole
			$UI/Timer.text = "0:%02d" % whole
		if _remaining <= 0.0:
			_finish()

	# Physics keeps running after the run ends, so the ball settles instead of
	# freezing in mid-air under the result card.
	_vy += GRAVITY * _unit * delta
	_ball_y += _vy * delta
	if _ball_y >= _ball_rest_y and _vy > 0.0:
		var impact := _vy / _unit
		_ball_y = _ball_rest_y
		if impact > REST_SPEED:
			_vy = -_vy * BOUNCE_DAMP
			_land(impact)
		else:
			_vy = 0.0

	# Squash and stretch springs back rather than being tweened, so a tap
	# landing mid-bounce simply replaces it.
	_squash = _squash * maxf(0.0, 1.0 - delta * 7.0)

	var base := _ball_r * 2.0 / 176.0          # the ball sprite is 176px across
	$Ball.position = Vector2(_ball_x, _ball_y)
	$Ball.scale = Vector2(base * (1.0 + _squash), base * (1.0 - _squash))

	# The shadow shrinks and fades as the ball climbs.
	var lift: float = clampf((_ball_rest_y - _ball_y) / (_unit * 4.0), 0.0, 1.0)
	var ss := _ball_r * 2.1 / 192.0 * maxf(0.35, 1.0 - lift * 0.5)
	$Shadow.position = Vector2(_ball_x, _ground_y + _unit * 0.05)
	$Shadow.scale = Vector2(ss, ss * 0.6)
	$Shadow.modulate.a = maxf(0.15, 0.75 - lift * 0.45)


func _land(impact: float) -> void:
	$BounceSfx.pitch_scale = 0.9 + minf(0.35, impact * 0.02)
	_play($BounceSfx)
	_squash = minf(0.34, 0.1 + impact * 0.016)

	var s := _ball_r * 1.5 / 96.0
	$Puff.visible = true
	$Puff.position = Vector2(_ball_x, _ground_y - _ball_r * 0.25)
	$Puff.scale = Vector2(s * 0.4, s * 0.4)
	$Puff.modulate.a = 0.75
	var tween := create_tween().set_parallel(true)
	tween.tween_property($Puff, "scale", Vector2(s, s), 0.34).set_ease(Tween.EASE_OUT)
	tween.tween_property($Puff, "modulate:a", 0.0, 0.34)
	tween.chain().tween_callback(func() -> void: $Puff.visible = false)


func _unhandled_input(event: InputEvent) -> void:
	# pointing/emulate_touch_from_mouse is on, so a mouse in the editor and a
	# finger on a phone arrive through the same event. Each finger has its own
	# index, so multi-touch works without extra handling.
	if _finished or not (event is InputEventScreenTouch and event.pressed):
		return
	var at: Vector2 = (event as InputEventScreenTouch).position

	# Generous hit area: a near miss that reads as a hit is a better failure
	# than a hit that reads as a miss.
	if at.distance_to(Vector2(_ball_x, _ball_y)) > _ball_r * 1.35:
		return

	if not _started:
		_started = true
		$UI/Hint.visible = false
	_taps += 1
	_score += _points_per_tap
	_refresh_score()
	_vy = -TAP_IMPULSE * _unit
	_squash = -0.2                 # stretch upward
	$TapSfx.pitch_scale = 0.95 + minf(0.5, _taps * 0.012)
	_play($TapSfx)


# ------------------------------------------------------------------------ end

func _flavour() -> String:
	var line := "Bounced the ball %d time%s." % [_taps, "" if _taps == 1 else "s"]
	if _best >= 0 and _score > _best:
		line += " A new personal best."
	return line


func _finish() -> void:
	if _finished:
		return                     # report_result must happen exactly once
	_finished = true

	if _music_started:
		create_tween().tween_property($Music, "volume_db", linear_to_db(0.001), 0.4)
	_play($FinishSfx)

	$UI/Hint.visible = false
	$UI/Timer.visible = false
	$UI/Score.visible = false      # the card carries the number now
	$UI/Dim.visible = true
	create_tween().tween_property($UI/Dim, "color", Color(0.04, 0.09, 0.13, 0.72), 0.3)
	_place_result()

	var best: int = maxi(_score, _best)
	# The one required call. `delay` holds the host's result screen back long
	# enough for the card to be seen; `user_data` is this player's single
	# persisted slot, so the next run can compare against it.
	Minit.report_result(_score, {
		"flavor_text": _flavour(),
		"user_data": str(best),
		"delay": END_DELAY_MS,
	})


func _place_result() -> void:
	# Stacked upward from just above where the ball comes to rest, rather than
	# pinned to fractions of the height -- fractions drift into the ball on a
	# wide slot, where there is much less sky above the grass line.
	var w := _viewport.x
	var line := _flavour()
	var ball_top := _ball_rest_y - _ball_r

	var cap_px := _fit(line, w * 0.88, _unit * 0.46)
	var score_px := _fit(str(_score), w * 0.8, _unit * 2.4)
	var lab_px := _fit("FINAL SCORE", w * 0.6, _unit * 0.6)

	var y := ball_top - _unit * 0.55 - cap_px * 0.5
	$UI/Caption.visible = true
	$UI/Caption.text = line
	_place_label($UI/Caption, w * 0.5, y, w * 0.92, cap_px)

	y -= cap_px * 0.5 + _unit * 0.25 + score_px * 0.5
	$UI/Result.visible = true
	$UI/Result.text = str(_score)
	_place_label($UI/Result, w * 0.5, y, w * 0.9, score_px)

	y -= score_px * 0.5 + _unit * 0.1 + lab_px * 0.5
	$UI/ResultLabel.visible = true
	_place_label($UI/ResultLabel, w * 0.5, y, w * 0.8, lab_px)
