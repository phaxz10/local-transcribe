import { useEffect } from 'react'
import { warmMicPermission } from '@/lib/mic'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useApp } from '@/lib/store'
import { FileTranscriber } from '@/components/FileTranscriber'
import { LiveMic } from '@/components/LiveMic'
import { NoModelState } from '@/components/NoModelState'
import { ScreenHeader } from '@/components/ScreenHeader'

export function Workspace() {
  const activeModel = useApp((s) => s.activeModel)
  const setView = useApp((s) => s.setView)
  const workspaceTab = useApp((s) => s.workspaceTab)
  const setWorkspaceTab = useApp((s) => s.setWorkspaceTab)
  useEffect(() => {
    if (activeModel) void warmMicPermission()
  }, [activeModel])

  if (!activeModel) {
    return <NoModelState onSetup={() => setView('onboarding')} />
  }

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
