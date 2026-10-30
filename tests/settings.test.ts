import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore, sanitizeSettings } from '../src/main/settings'

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'tal-settings-')), 'settings.json')

describe('sanitizeSettings', () => {
  it('returns defaults for missing or non-object input', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings('nope')).toEqual(DEFAULT_SETTINGS)
  })

  it('uses precise word timing by default and can turn it off', () => {
    expect(DEFAULT_SETTINGS.wordLevel).toBe(true)
    expect(sanitizeSettings({ wordLevel: false }).wordLevel).toBe(false)
    expect(sanitizeSettings({ wordLevel: 1 }).wordLevel).toBe(true)
  })

  it('does not lock Windows from the lyrics screen unless asked to', () => {
    expect(DEFAULT_SETTINGS.lockOnReturn).toBe(false)
    expect(sanitizeSettings({ lockOnReturn: 'yes' }).lockOnReturn).toBe(false)
  })

  it('repairs each invalid field on its own', () => {
    const s = sanitizeSettings({
      style: 'x',
      offsetMs: 99999,
      colors: { lyric: 'red', highlight: '#00FF00' },
      idleMinutes: 3,
      showOn: 'always'
    })
    expect(s.style).toBe('ship')
    expect(s.offsetMs).toBe(1000)
    expect(s.colors.lyric).toBe(DEFAULT_SETTINGS.colors.lyric)
    expect(s.colors.highlight).toBe('#00ff00')
    expect(s.colors.secondary).toBe(DEFAULT_SETTINGS.colors.secondary)
    expect(s.idleMinutes).toBe(2)
    expect(s.showOn).toBe('always')
  })

  it('keeps valid values and rounds the offset', () => {
    const s = sanitizeSettings({
      style: 'fisheye-visual',
      showOn: 'lock',
      displayId: 42,
      autoSync: true,
      offsetMs: -250.4,
      idleMinutes: 0,
      source: 'all',
      allPlayers: true,
      launchAtLogin: true,
      welcomed: true,
      lockOnReturn: true
    })
    expect(s).toMatchObject({
      lockOnReturn: true,
      style: 'fisheye-visual',
      displayId: 42,
      autoSync: true,
      offsetMs: -250,
      idleMinutes: 0,
      source: 'all',
      allPlayers: true,
      launchAtLogin: true,
      welcomed: true
    })
  })

  describe('player source', () => {
    it('defaults to Spotify and Apple Music', () => {
      expect(DEFAULT_SETTINGS.source).toBe('default')
      expect(sanitizeSettings(undefined).source).toBe('default')
      expect(sanitizeSettings(undefined).allPlayers).toBe(false)
    })

    it('keeps a valid source and repairs an invalid one', () => {
      expect(sanitizeSettings({ source: 'kodama' }).source).toBe('kodama')
      expect(sanitizeSettings({ source: 'kodama' }).allPlayers).toBe(false)
      expect(sanitizeSettings({ source: 'curry' }).source).toBe('default')
      expect(sanitizeSettings({ source: 2 }).source).toBe('default')
    })

    it('migrates the old All Media Apps flag to the "all" source', () => {
      expect(sanitizeSettings({ allPlayers: true }).source).toBe('all')
      expect(sanitizeSettings({ allPlayers: true }).allPlayers).toBe(true)
      expect(sanitizeSettings({ allPlayers: false }).source).toBe('default')
      expect(sanitizeSettings({ }).source).toBe('default')
    })

    it('lets an explicit source win over the legacy flag', () => {
      expect(sanitizeSettings({ source: 'kodama', allPlayers: true }).source).toBe('kodama')
      expect(sanitizeSettings({ source: 'kodama', allPlayers: true }).allPlayers).toBe(false)
    })

    it('derives allPlayers from the source in the other direction', () => {
      expect(sanitizeSettings({ source: 'all' }).allPlayers).toBe(true)
      expect(sanitizeSettings({ source: 'default' }).allPlayers).toBe(false)
    })
  })
})

describe('SettingsStore', () => {
  it('persists updates across instances', () => {
    const file = tempFile()
    new SettingsStore(file).update({ style: 'visual', offsetMs: -250 })
    const reopened = new SettingsStore(file)
    expect(reopened.get().style).toBe('visual')
    expect(JSON.parse(readFileSync(file, 'utf8')).offsetMs).toBe(-250)
  })

  it('persists a saved Kodama player choice across restarts', () => {
    const file = tempFile()
    new SettingsStore(file).update({ source: 'kodama' })
    const reopened = new SettingsStore(file)
    expect(reopened.get().source).toBe('kodama')
    expect(reopened.get().allPlayers).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).source).toBe('kodama')
  })

  it('an old All Media Apps settings file opens as "all"', () => {
    const file = tempFile()
    const legacy = { ...DEFAULT_SETTINGS, source: undefined, allPlayers: true } as Record<string, unknown>
    delete legacy.source
    writeFileSync(file, JSON.stringify(legacy), 'utf8')
    expect(new SettingsStore(file).get().source).toBe('all')
  })

  it('an old Spotify-only settings file opens as "default"', () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ style: 'ship' }), 'utf8')
    expect(new SettingsStore(file).get().source).toBe('default')
  })

  it('merges partial colour updates', () => {
    const store = new SettingsStore(tempFile())
    store.update({ colors: { ...store.get().colors, lyric: '#112233' } })
    expect(store.get().colors).toEqual({ ...DEFAULT_SETTINGS.colors, lyric: '#112233' })
  })

  it('notifies listeners and supports unsubscribe', () => {
    const store = new SettingsStore(tempFile())
    const listener = vi.fn()
    const off = store.onChange(listener)
    store.update({ autoSync: true })
    off()
    store.update({ autoSync: false })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0].autoSync).toBe(true)
  })

  it('falls back to defaults when the file is corrupt', () => {
    const file = tempFile()
    writeFileSync(file, '{not json', 'utf8')
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS)
  })
})
