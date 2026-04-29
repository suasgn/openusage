import { useCallback } from "react"
import { CircleHelp, Settings } from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { invoke } from "@tauri-apps/api/core"
import { APP_NEW_ISSUE_URL } from "@/lib/brand"
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu"
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

function GaugeIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M9.367 2.25c-1.092 0-1.958 0-2.655.057c-.714.058-1.317.18-1.868.46a4.75 4.75 0 0 0-2.076 2.077c-.281.55-.403 1.154-.461 1.868c-.057.697-.057 1.563-.057 2.655v5.266c0 1.092 0 1.958.057 2.655c.058.714.18 1.317.46 1.869a4.75 4.75 0 0 0 2.077 2.075c.55.281 1.154.403 1.868.461c.697.057 1.563.057 2.655.057h5.266c1.092 0 1.958 0 2.655-.057c.714-.058 1.317-.18 1.869-.46a4.75 4.75 0 0 0 2.075-2.076c.281-.552.403-1.155.461-1.869c.057-.697.057-1.563.057-2.655V9.367c0-1.092 0-1.958-.057-2.655c-.058-.714-.18-1.317-.46-1.868a4.75 4.75 0 0 0-2.076-2.076c-.552-.281-1.155-.403-1.869-.461c-.697-.057-1.563-.057-2.655-.057zm-.484 12.4a.75.75 0 0 1 .9 0l.884.662l.883-.662a.75.75 0 0 1 .9 0l.883.662l.884-.662a.75.75 0 0 1 .9 0l1.333 1a.75.75 0 1 1-.9 1.2l-.883-.663l-.884.663a.75.75 0 0 1-.9 0L12 16.187l-.883.663a.75.75 0 0 1-.9 0l-.884-.663l-.883.663a.75.75 0 1 1-.9-1.2zM8.45 8.4l2 1.5a.75.75 0 0 1 0 1.2l-2 1.5a.75.75 0 1 1-.9-1.2l1.2-.9l-1.2-.9a.75.75 0 0 1 .9-1.2m8.15.15a.75.75 0 0 1-.15 1.05l-1.2.9l1.2.9a.75.75 0 1 1-.9 1.2l-2-1.5a.75.75 0 0 1 0-1.2l2-1.5a.75.75 0 0 1 1.05.15" />
    </svg>
  )
}
import { cn } from "@/lib/utils"
import { getRelativeLuminance } from "@/lib/color"
import { useDarkMode } from "@/hooks/use-dark-mode"

type ActiveView = "home" | "settings" | string

type PluginContextAction = "reload"

interface NavPlugin {
  id: string
  name: string
  iconUrl: string
  brandColor?: string
}

interface SideNavProps {
  activeView: ActiveView
  onViewChange: (view: ActiveView) => void
  plugins: NavPlugin[]
  onPluginContextAction?: (pluginId: string, action: PluginContextAction) => void
  isPluginRefreshAvailable?: (pluginId: string) => boolean
  onReorder?: (orderedIds: string[]) => void
}

interface NavButtonProps {
  isActive: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  children: React.ReactNode
  "aria-label"?: string
}

function NavButton({ isActive, onClick, onContextMenu, children, "aria-label": ariaLabel }: NavButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-label={ariaLabel}
      className={cn(
        "relative flex items-center justify-center w-full p-2.5 transition-colors",
        "hover:bg-accent",
        isActive
          ? "text-foreground before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:bg-primary dark:before:bg-page-accent before:rounded-full"
          : "text-muted-foreground"
      )}
    >
      {children}
    </button>
  )
}

function getIconColor(brandColor: string | undefined, isDark: boolean): string {
  if (!brandColor) return "currentColor"
  const luminance = getRelativeLuminance(brandColor)
  if (isDark && luminance < 0.15) return "#ffffff"
  if (!isDark && luminance > 0.85) return "currentColor"
  return brandColor
}

interface SortableNavPluginProps {
  plugin: NavPlugin
  isActive: boolean
  isDark: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

function SortableNavPlugin({ plugin, isActive, isDark, onClick, onContextMenu }: SortableNavPluginProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: plugin.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} role="presentation">
      <NavButton
        isActive={isActive}
        onClick={onClick}
        onContextMenu={onContextMenu}
        aria-label={plugin.name}
      >
        <span
          role="img"
          aria-label={plugin.name}
          className="size-6 inline-block"
          style={{
            backgroundColor: getIconColor(plugin.brandColor, isDark),
            WebkitMaskImage: `url(${plugin.iconUrl})`,
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskImage: `url(${plugin.iconUrl})`,
            maskSize: "contain",
            maskRepeat: "no-repeat",
            maskPosition: "center",
          }}
        />
      </NavButton>
    </div>
  )
}

export function SideNav({
  activeView,
  onViewChange,
  plugins,
  onPluginContextAction,
  isPluginRefreshAvailable,
  onReorder,
}: SideNavProps) {
  const isDark = useDarkMode()

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!onReorder) return
      const { active, over } = event
      if (over && active.id !== over.id) {
        const oldIndex = plugins.findIndex((p) => p.id === active.id)
        const newIndex = plugins.findIndex((p) => p.id === over.id)
        if (oldIndex === -1 || newIndex === -1) return
        const next = arrayMove(plugins, oldIndex, newIndex)
        onReorder(next.map((p) => p.id))
      }
    },
    [onReorder, plugins]
  )

  const handlePluginContextMenu = useCallback(
    (e: React.MouseEvent, pluginId: string) => {
      e.preventDefault()
      if (!onPluginContextAction) return

      ;(async () => {
        const reloadItem = await MenuItem.new({
          id: `ctx-reload-${pluginId}`,
          text: "Refresh usage",
          enabled: isPluginRefreshAvailable ? isPluginRefreshAvailable(pluginId) : true,
          action: () => onPluginContextAction(pluginId, "reload"),
        })
        const bottomSeparator = await PredefinedMenuItem.new({ item: "Separator" })
        const inspectItem = await MenuItem.new({
          id: `ctx-inspect-${pluginId}`,
          text: "Inspect Element",
          action: () => {
            invoke("open_devtools").catch(console.error)
          },
        })
        const menu = await Menu.new({
          items: [reloadItem, bottomSeparator, inspectItem],
        })
        try {
          await menu.popup()
        } finally {
          await Promise.allSettled([
            menu.close(),
            reloadItem.close(),
            bottomSeparator.close(),
            inspectItem.close(),
          ])
        }
      })().catch(console.error)
    },
    [isPluginRefreshAvailable, onPluginContextAction]
  )

  return (
    <nav className="flex h-full min-h-0 w-12 flex-col overflow-hidden border-r bg-muted/50 py-3 dark:bg-card">
      {/* Home */}
      <NavButton
        isActive={activeView === "home"}
        onClick={() => onViewChange("home")}
        aria-label="Home"
      >
        <GaugeIcon className="size-6 dark:text-page-accent" />
      </NavButton>

      {/* Plugin icons */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain py-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={plugins.map((p) => p.id)}
            strategy={verticalListSortingStrategy}
          >
            {plugins.map((plugin) => (
              <SortableNavPlugin
                key={plugin.id}
                plugin={plugin}
                isActive={activeView === plugin.id}
                isDark={isDark}
                onClick={() => onViewChange(plugin.id)}
                onContextMenu={(e) => handlePluginContextMenu(e, plugin.id)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      <div className="mt-auto shrink-0">
        {/* Help */}
        <NavButton
          isActive={false}
          onClick={() => {
            openUrl(APP_NEW_ISSUE_URL).catch(console.error)
            invoke("hide_panel").catch(console.error)
          }}
          aria-label="Help"
        >
          <CircleHelp className="size-6" />
        </NavButton>

        {/* Settings */}
        <NavButton
          isActive={activeView === "settings"}
          onClick={() => onViewChange("settings")}
          aria-label="Settings"
        >
          <Settings className="size-6" />
        </NavButton>
      </div>
    </nav>
  )
}

export type { ActiveView, NavPlugin, PluginContextAction }
