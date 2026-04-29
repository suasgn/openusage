import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { savePluginSettingsMock, trackMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  savePluginSettingsMock: vi.fn(),
}))

vi.mock("@/lib/analytics", () => ({
  track: trackMock,
}))

vi.mock("@/lib/settings", () => ({
  savePluginSettings: savePluginSettingsMock,
}))

import { useSettingsPluginActions } from "@/hooks/app/use-settings-plugin-actions"

describe("useSettingsPluginActions", () => {
  beforeEach(() => {
    trackMock.mockReset()
    savePluginSettingsMock.mockReset()
    savePluginSettingsMock.mockResolvedValue(undefined)
  })

  it("reorders plugins and persists new order", () => {
    const setPluginSettings = vi.fn()
    const scheduleTrayIconUpdate = vi.fn()

    const { result } = renderHook(() =>
      useSettingsPluginActions({
        pluginSettings: { order: ["a", "b"], disabled: [] },
        setPluginSettings,
        scheduleTrayIconUpdate,
      })
    )

    act(() => {
      result.current.handleReorder(["b", "a"])
    })

    expect(trackMock).toHaveBeenCalledWith("providers_reordered", { count: 2 })
    expect(setPluginSettings).toHaveBeenCalledWith({ order: ["b", "a"], disabled: [] })
    expect(savePluginSettingsMock).toHaveBeenCalledWith({ order: ["b", "a"], disabled: [] })
    expect(scheduleTrayIconUpdate).toHaveBeenCalledWith("settings", 2000)
  })

  it("reorder from sidebar subset preserves missing plugins in order", () => {
    const setPluginSettings = vi.fn()

    const { result } = renderHook(() =>
      useSettingsPluginActions({
        pluginSettings: { order: ["a", "b", "c"], disabled: ["b"] },
        setPluginSettings,
        scheduleTrayIconUpdate: vi.fn(),
      })
    )

    act(() => {
      result.current.handleReorder(["c", "a"])
    })

    const expectedSettings = { order: ["c", "a", "b"], disabled: ["b"] }
    expect(setPluginSettings).toHaveBeenCalledWith(expectedSettings)
    expect(savePluginSettingsMock).toHaveBeenCalledWith(expectedSettings)
  })

  it("reorder from sidebar prepends missing plugin that originally led the order", () => {
    const setPluginSettings = vi.fn()

    const { result } = renderHook(() =>
      useSettingsPluginActions({
        pluginSettings: { order: ["b", "a", "c"], disabled: ["b"] },
        setPluginSettings,
        scheduleTrayIconUpdate: vi.fn(),
      })
    )

    act(() => {
      result.current.handleReorder(["c", "a"])
    })

    const expectedSettings = { order: ["b", "c", "a"], disabled: ["b"] }
    expect(setPluginSettings).toHaveBeenCalledWith(expectedSettings)
    expect(savePluginSettingsMock).toHaveBeenCalledWith(expectedSettings)
  })

  it("reorder tolerates missing saved order metadata", () => {
    const setPluginSettings = vi.fn()

    const { result } = renderHook(() =>
      useSettingsPluginActions({
        pluginSettings: { order: undefined as unknown as string[], disabled: [] },
        setPluginSettings,
        scheduleTrayIconUpdate: vi.fn(),
      })
    )

    act(() => {
      result.current.handleReorder(["c", "a"])
    })

    expect(setPluginSettings).toHaveBeenCalledWith({ order: ["c", "a"], disabled: [] })
    expect(savePluginSettingsMock).toHaveBeenCalledWith({ order: ["c", "a"], disabled: [] })
  })

  it("reorder restores the full saved order when no visible plugins are passed", () => {
    const setPluginSettings = vi.fn()

    const { result } = renderHook(() =>
      useSettingsPluginActions({
        pluginSettings: { order: ["b", "a", "c"], disabled: ["b"] },
        setPluginSettings,
        scheduleTrayIconUpdate: vi.fn(),
      })
    )

    act(() => {
      result.current.handleReorder([])
    })

    expect(setPluginSettings).toHaveBeenCalledWith({ order: ["b", "a", "c"], disabled: ["b"] })
    expect(savePluginSettingsMock).toHaveBeenCalledWith({ order: ["b", "a", "c"], disabled: ["b"] })
  })

  it("reorder tolerates order metadata disappearing during merge", () => {
    const setPluginSettings = vi.fn()
    let orderReads = 0
    const pluginSettings = {
      disabled: [],
      get order() {
        orderReads += 1
        return orderReads === 1 ? ["b", "a"] : undefined
      },
    } as unknown as { order: string[]; disabled: string[] }

    const { result } = renderHook(() =>
      useSettingsPluginActions({
        pluginSettings,
        setPluginSettings,
        scheduleTrayIconUpdate: vi.fn(),
      })
    )

    act(() => {
      result.current.handleReorder(["a"])
    })

    expect(setPluginSettings).toHaveBeenCalledWith({ order: ["b", "a"], disabled: [] })
    expect(savePluginSettingsMock).toHaveBeenCalledWith({ order: ["b", "a"], disabled: [] })
  })

  it("toggles plugin enabled state and persists disabled list", () => {
    const setPluginSettings = vi.fn()
    const scheduleTrayIconUpdate = vi.fn()

    const { result } = renderHook(() =>
      useSettingsPluginActions({
        pluginSettings: { order: ["a", "b"], disabled: [] },
        setPluginSettings,
        scheduleTrayIconUpdate,
      })
    )

    act(() => {
      result.current.handleToggle("b", false)
    })

    const expectedSettings = { order: ["a", "b"], disabled: ["b"] }
    expect(trackMock).toHaveBeenCalledWith("provider_toggled", { provider_id: "b", enabled: "false" })
    expect(setPluginSettings).toHaveBeenCalledWith(expectedSettings)
    expect(savePluginSettingsMock).toHaveBeenCalledWith(expectedSettings)
    expect(scheduleTrayIconUpdate).toHaveBeenCalledWith("settings", 2000)
  })

  it("returns early when plugin settings are missing", () => {
    const setPluginSettings = vi.fn()

    const { result } = renderHook(() =>
      useSettingsPluginActions({
        pluginSettings: null,
        setPluginSettings,
        scheduleTrayIconUpdate: vi.fn(),
      })
    )

    act(() => {
      result.current.handleReorder(["a"])
    })

    expect(setPluginSettings).not.toHaveBeenCalled()
    expect(savePluginSettingsMock).not.toHaveBeenCalled()
    expect(trackMock).not.toHaveBeenCalled()
  })
})
