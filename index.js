/*
 * https://developer.mozilla.org/en-US/docs/Web/API/ScriptProcessorNode
 * https://www.warpdesign.fr/webaudio-from-scriptprocessornode-to-the-new-audioworklet-api/
 * https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet
 */
import Screamtracker from './lib/st3'
import Protracker from './lib/pt'
import Fasttracker from './lib/ft2'

const READY = 0
const EMPTY = 1
const PLAY = 2
const PAUSED = 3
const STOPPED = 4
const AudioContext = window.AudioContext || window.webkitAudioContext

class ModPlayer {
  static normBuffer (input) { return Buffer.from(input) }
  constructor (observer) {
    this._emit = (...a) => observer && observer(...a)
    this.player = null
    this.context = null
    this.mixerNode = null
    this.amiga500 = false
    this.state = EMPTY
    this._emit('state', EMPTY)
    this._forceLoop = true
  }

  loadBuffer (type, buffer) {
    buffer = ModPlayer.normBuffer(buffer)
    switch (type) {
      case 's3m':
      case 'audio/x-s3m':
        this.player = new Screamtracker()
        break
      case 'audio/x-mod':
      case 'mod':
        this.player = new Protracker()
        break
      case 'audio/x-xm':
      case 'xm':
        this.player = new Fasttracker()
        break
      default:
        throw new Error(`unknown mod format ${type}`)
    }

    if (!this.player.parse(buffer)) {
      console.error('Failed to load song')
      return
    }
    this._adjustLowpass()
    this._chvu = new Float32Array(this.player.channels)
    this.state = READY
    this._emit('state', READY)
  }

  get title () { return this.player && this.player.title }
  get signature () { return this.player && this.player.signature }
  get songLength () { return this.player && this.player.songLength }
  get channels () { return this.player && this.player.channels }
  get patterns () { return this.player && this.player.patterns }
  get sampleNames () {
    return this.player &&
      (this.player.instrument || this.player.sample || [{ name: '<Failed to load names>' }])
        .map(i => i.name || '')
  }

  get desc () {
    return (this.sampleNames || []).join('\n').replace(/\n+/g, '\n')
  }

  pause () {
    if (this.state !== PLAY) return
    this.state = PAUSED
    this.player.paused = true
    this.player.playing = false
    this._emit('state', this.state)
  }

  stop () {
    this.player.paused = false
    this.player.playing = false
    this.player.endofsong = true
    this.state = STOPPED
    this._emit('state', this.state)
  }

  restart () {
    this.player.position = 0
    this.player.paused = false
    this.player.playing = true
    this.player.endofsong = false
  }

  play () {
    switch (this.state) {
      case READY:
        break // Only states that proceeds.
      // All other states return.
      case PAUSED:
        this.player.paused = false
        this.player.playing = true
        this._emit('state', this.state)
      default: // eslint-disable-line no-fallthrough
        return
    }

    if (!this.context) this.createContext()
    this._adjustLowpass()

    if (this.player.paused) {
      this.player.paused = false
      return true
    }

    // this.endofsong = false
    this.player.endofsong = false
    this.player.paused = false
    this.player.initialize()
    this.player.flags = 1 + 2
    this.player.playing = true

    /*
    for (let i = 0; i < this.player.channels; i++) this.chvu[i] = 0.0
    this.player.delayfirst = this.bufferstodelay
    */
    this.state = PLAY
    this._emit('state', PLAY)
    return true
  }

  createContext () {
    this.context = new AudioContext()
    const samplerate = this.context.sampleRate

    this.player.samplerate = samplerate
    const bufferlen = (samplerate > 44100) ? 4096 : 2048

    // Amiga 500 fixed filter at 6kHz. WebAudio lowpass is 12dB/oct, whereas
    // older Amigas had a 6dB/oct filter at 4900Hz.
    this.filterNode = this.context.createBiquadFilter()

    this.filterNode.frequency.value = this.amiga500 ? 6000 : 22050

    // "LED filter" at 3275kHz - off by default
    this.lowpassNode = this.context.createBiquadFilter()
    this._adjustLowpass()

    // mixer
    if (typeof this.context.createJavaScriptNode === 'function') {
      this.mixerNode = this.context.createJavaScriptNode(bufferlen, 1, 2)
    } else {
      this.mixerNode = this.context.createScriptProcessor(bufferlen, 1, 2)
    }

    this.mixerNode.onaudioprocess = this._process.bind(this)

    // patch up some cables :)
    this.mixerNode.connect(this.filterNode)
    this.filterNode.connect(this.lowpassNode)
    this.lowpassNode.connect(this.context.destination)
  }

  _adjustLowpass () {
    if (!this.lowpassNode || !this.player) return
    this.lowpassNode.frequency.value = this.player.filter ? 3275 : 28867
  }

  set filter (f) {
    if (this.player) this.player.filter = f
  }

  get filter () { return this.player && this.player.filter }

  // ev: audioProcessingEvent
  _process (ev) {
    const bufs = [
      ev.outputBuffer.getChannelData(0),
      ev.outputBuffer.getChannelData(1)
    ]
    const buflen = ev.outputBuffer.length
    this.player.mix(this.player, bufs, buflen)

    for (let i = 0; i < this.player.channels; i++) {
      // Smooth vu meters by 25%
      this._chvu[i] = this._chvu[i] * 0.25 + this.player.chvu[i] * 0.75
      if (this.player.chvu) this.player.chvu[i] = 0.0 // why??
    }
    if (this.state === PLAY) {
      this._emit('tick', {
        row: this.player.row,
        position: this.player.position,
        speed: this.player.speed,
        bpm: this.player.bpm,
        endofsong: this.player.endofsong,
        chvu: this._chvu
      })
    }

    // apply stereo separation and soft clipping
    const outp = new Float32Array(2)
    for (let s = 0; s < buflen; s++) {
      outp[0] = bufs[0][s]
      outp[1] = bufs[1][s]

      const separation = 1
      // a more headphone-friendly stereo separation
      if (separation) {
        const t = outp[0]
        if (separation === 2) { // mono
          outp[0] = outp[0] * 0.5 + outp[1] * 0.5
          outp[1] = outp[1] * 0.5 + t * 0.5
        } else { // narrow stereo
          outp[0] = outp[0] * 0.65 + outp[1] * 0.35
          outp[1] = outp[1] * 0.65 + t * 0.35
        }
      }
      const mixval = 2.0
      // scale down and soft clip
      outp[0] /= mixval; outp[0] = 0.5 * (Math.abs(outp[0] + 0.975) - Math.abs(outp[0] - 0.975))
      outp[1] /= mixval; outp[1] = 0.5 * (Math.abs(outp[1] + 0.975) - Math.abs(outp[1] - 0.975))

      bufs[0][s] = outp[0]
      bufs[1][s] = outp[1]
    }

    if (this.player.endofsong && this.player.playing) this._forceLoop ? this.restart() : this.stop()
  }
}
export default ModPlayer
