import { useEffect } from 'react'
import { warmMicPermission } from '@/lib/mic'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useApp } from '@/lib/store'
import { canTranslate } from '@/lib/catalog'
import { PRIMARY_LANGUAGES, type PrimaryLanguage } from '@/lib/types'
import { FileTranscriber } from '@/components/FileTranscriber'
import { LiveMic } from '@/components/LiveMic'
import { NoModelState } from '@/components/NoModelState'
import { ScreenHeader } from '@/components/ScreenHeader'

export function Workspace() {
  const activeModel = useApp((s) => s.activeModel)
  const setView = useApp((s) => s.setView)
  const workspaceTab = useApp((s) => s.workspaceTab)
  const setWorkspaceTab = useApp((s) => s.setWorkspaceTab)
  const primaryLanguage = useApp((s) => s.primaryLanguage)
  const sessionLanguage = useApp((s) => s.sessionLanguage)
  const setSessionLanguage = useApp((s) => s.setSessionLanguage)
  const translate = useApp((s) => s.translate)
  const setTranslate = useApp((s) => s.setTranslate)
  useEffect(() => {
    if (activeModel) void warmMicPermission()
  }, [activeModel])

  if (!activeModel) {
    return <NoModelState onSetup={() => setView('onboarding')} />
  }

  // A model that speaks one language only has nothing to pick, so it gets a note instead of a
  // Select. The Session Language overrides the Primary Language for this screen only.
  const fixedLanguage = activeModel.englishOnly || !!activeModel.forceLanguage
  const language = sessionLanguage ?? primaryLanguage

  return (
    <div className="space-y-8">
      <ScreenHeader
        title="Transcribe"
        subtitle="Audio and text stay in this browser."
        aside={
          <button
            onClick={() => setView('onboarding')}
            title="Change model or manage downloads"
            className="lt-eyebrow rounded-md px-2 py-1.5 lg:hidden outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {activeModel.label}
          </button>
        }
      />

      <div className="-mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        {fixedLanguage ? (
          <p className="text-xs text-muted-foreground">
            {/* ponytail: `forceLanguage` models are also "one language only", so they share this
                line rather than naming their own language. */}
            {activeModel.label} transcribes{' '}
            {activeModel.englishOnly ? 'English' : 'one fixed language'} only. Switch model for
            other languages.{' '}
            {language !== 'en' && (
              <button onClick={() => setView('onboarding')} className="lt-link">
                Models
              </button>
            )}
          </p>
        ) : (
          <div className="flex items-center gap-3">
            <Label htmlFor="session-lang" className="lt-eyebrow">
              Language
            </Label>
            <Select
              value={language}
              onValueChange={(v) => setSessionLanguage(v as PrimaryLanguage)}
            >
              <SelectTrigger id="session-lang" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIMARY_LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {canTranslate(activeModel) && (
          <div className="flex items-center gap-2">
            <Switch id="translate" checked={translate} onCheckedChange={setTranslate} />
            <Label htmlFor="translate" className="lt-eyebrow">
              Translate to English
            </Label>
          </div>
        )}
      </div>

      <Tabs value={workspaceTab} onValueChange={(v) => setWorkspaceTab(v as 'file' | 'live')}>
        <TabsList>
          <TabsTrigger value="file">File</TabsTrigger>
          <TabsTrigger value="live">Live</TabsTrigger>
        </TabsList>
        <TabsContent value="file">
          <FileTranscriber />
        </TabsContent>
        <TabsContent value="live">
          <LiveMic />
        </TabsContent>
      </Tabs>
    </div>
  )
}
