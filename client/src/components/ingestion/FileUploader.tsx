import { useCallback, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Upload, X, FileText } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'

export interface UploadedFile {
  filename: string
  content: string
  moduleId: string
}

interface FileUploaderProps {
  files: UploadedFile[]
  onFilesChange: (files: UploadedFile[]) => void
  /** Default module id assigned to newly-dropped files. */
  defaultModuleId?: string
}

export function FileUploader({ files, onFilesChange, defaultModuleId }: FileUploaderProps) {
  const exams = useAppStore((s) => s.exams)
  const [dragOver, setDragOver] = useState(false)

  const handleFiles = useCallback(
    async (fileList: FileList) => {
      const newFiles: UploadedFile[] = []
      for (const file of Array.from(fileList)) {
        if (!file.name.endsWith('.md') && !file.name.endsWith('.txt')) continue
        const content = await file.text()
        newFiles.push({
          filename: file.name,
          content,
          moduleId: defaultModuleId || exams[0]?.id || '',
        })
      }
      onFilesChange([...files, ...newFiles])
    },
    [files, onFilesChange, exams, defaultModuleId]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      handleFiles(e.dataTransfer.files)
    },
    [handleFiles]
  )

  const removeFile = (index: number) => {
    onFilesChange(files.filter((_, i) => i !== index))
  }

  const updateModule = (index: number, moduleId: string) => {
    const updated = [...files]
    updated[index] = { ...updated[index], moduleId }
    onFilesChange(updated)
  }

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
          dragOver
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-muted-foreground/50'
        }`}
      >
        <Upload className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground mb-2">
          Drag & drop markdown files here, or click to browse
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const input = document.createElement('input')
            input.type = 'file'
            input.multiple = true
            input.accept = '.md,.txt'
            input.onchange = (e) => {
              const target = e.target as HTMLInputElement
              if (target.files) handleFiles(target.files)
            }
            input.click()
          }}
        >
          Browse Files
        </Button>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((file, index) => (
            <Card key={index}>
              <CardContent className="flex items-center gap-3 py-3">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium flex-1 truncate">
                  {file.filename}
                </span>
                <Badge variant="secondary" className="text-xs">
                  {Math.round(file.content.length / 1024)}KB
                </Badge>
                <select
                  value={file.moduleId}
                  onChange={(e) => updateModule(index, e.target.value)}
                  className="text-sm border rounded-md px-2 py-1 bg-background"
                >
                  {exams.map((exam) => (
                    <option key={exam.id} value={exam.id}>
                      {exam.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeFile(index)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
