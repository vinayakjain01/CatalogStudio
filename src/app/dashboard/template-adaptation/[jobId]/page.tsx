import { JobProgressGallery } from '@/components/template-adaptation/job-progress-gallery'

export default async function TemplateAdaptationJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>
}) {
  const { jobId } = await params

  return (
    <div className="space-y-6">
      <JobProgressGallery jobId={jobId} />
    </div>
  )
}
