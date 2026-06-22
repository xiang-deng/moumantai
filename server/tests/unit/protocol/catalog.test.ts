import { describe, it, expect } from 'vitest'
import { DeviceClass, SizeClass } from '@moumantai/protocol/generated/moumantai/v1'
import {
  CATALOG,
  getCatalogEntry,
  getCatalogForDevice,
  getAllBuilderNames,
  getAllComponentTypes,
  deviceClassToPlatform,
  filterComponentsForDevice,
  Platform,
} from '../../../src/server/protocol/catalog'
import { classifyWidth } from '../../../src/server/transport/ws-server'
import { text, tabs, modal, button, box } from '../../../src/server/protocol/components'

describe('component catalog', () => {
  it('builder names and component types have 1:1 correspondence', () => {
    const builders = getAllBuilderNames()
    const types = getAllComponentTypes()
    expect(builders.length).toBe(types.length)
    expect(builders.length).toBe(CATALOG.length)
    for (const t of types) {
      expect(getCatalogEntry(t)).toBeDefined()
    }
  })

  it('watch supports all touch components (auto-adaptation handles rendering)', () => {
    const watchTypes = getCatalogForDevice(DeviceClass.WATCH).map((e) => e.type)
    expect(watchTypes).toContain('Scaffold')
    expect(watchTypes).toContain('Button')
    expect(watchTypes).toContain('Chip')
    expect(watchTypes).toContain('List')
  })

  it('glass excludes interactive components', () => {
    const glassTypes = getCatalogForDevice(DeviceClass.GLASS).map((e) => e.type)
    expect(glassTypes).toContain('Text')
    expect(glassTypes).toContain('Icon')
    expect(glassTypes).toContain('Column')
    expect(glassTypes).not.toContain('Button')
    expect(glassTypes).not.toContain('TextField')
  })
})

describe('classifyWidth', () => {
  it('classifies watch (192dp) as compact', () => {
    expect(classifyWidth(192)).toBe(SizeClass.COMPACT)
  })

  it('classifies iot-small (240dp) as compact', () => {
    expect(classifyWidth(240)).toBe(SizeClass.COMPACT)
  })

  it('classifies hmi-panel (320dp) as expanded', () => {
    expect(classifyWidth(320)).toBe(SizeClass.EXPANDED)
  })

  it('classifies phone (390dp) as expanded', () => {
    expect(classifyWidth(390)).toBe(SizeClass.EXPANDED)
  })

  it('boundary: 240 is compact, 241 is expanded', () => {
    expect(classifyWidth(240)).toBe(SizeClass.COMPACT)
    expect(classifyWidth(241)).toBe(SizeClass.EXPANDED)
  })
})

describe('deviceClassToPlatform', () => {
  it('maps device classes to platforms', () => {
    expect(deviceClassToPlatform(DeviceClass.WATCH)).toBe(Platform.WEAROS)
    expect(deviceClassToPlatform(DeviceClass.IOT_SMALL)).toBe(Platform.ANDROID)
    expect(deviceClassToPlatform(DeviceClass.PHONE)).toBe(Platform.ANDROID)
    expect(deviceClassToPlatform(DeviceClass.HMI_PANEL)).toBe(Platform.ESP32)
    expect(deviceClassToPlatform(DeviceClass.GLASS)).toBe(Platform.WEB)
  })
})

describe('filterComponentsForDevice', () => {
  const components = [
    text('a', 'hello'),
    tabs('b', ['one'], ['c1']),
    modal('c', ['child']),
    button('d', 'click'),
    box('e', ['a']),
  ]

  it('phone: returns all components', () => {
    expect(filterComponentsForDevice(components, DeviceClass.PHONE)).toHaveLength(5)
  })

  it('hmi-panel (esp32): keeps Text/Tabs/Button/Box; strips Modal (inline-only renderer)', () => {
    // ESP32 has full renderers for Tabs (interactive.c:render_tabs) and Box
    // (layout.c:render_box). Modal stays stripped because the ESP32 renderer
    // is inline-only (no overlay layer) — authors should not target HMI_PANEL
    // for true overlay UX. See catalog.ts comments for full rationale.
    const result = filterComponentsForDevice(components, DeviceClass.HMI_PANEL)
    expect(result.map((c) => c.component.case)).toEqual(['text', 'tabs', 'button', 'box'])
  })

  it('watch: keeps Tabs/Modal/Box (Wear renders them)', () => {
    expect(filterComponentsForDevice(components, DeviceClass.WATCH)).toHaveLength(5)
  })

  it('glass: voice-only — keeps only Text/Icon/Column, strips Box', () => {
    const result = filterComponentsForDevice(components, DeviceClass.GLASS)
    expect(result.map((c) => c.component.case)).toEqual(['text'])
  })
})
