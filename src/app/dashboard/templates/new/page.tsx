import { TemplateBuilderClient } from '@/components/builder/template-builder-client'

import { createClient } from '@/lib/supabase/server'

import { getEditorPreviewSeed } from '@/lib/editor-preview'



export default async function NewTemplatePage() {

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()



  const { data: categories } = await supabase

    .from('template_categories')

    .select('*')

    .eq('user_id', user!.id)

    .order('name')



  const { storeId, previewProducts } = await getEditorPreviewSeed(user!.id)



  return (

    <TemplateBuilderClient

      categories={categories || []}

      storeId={storeId}

      previewProducts={previewProducts}

    />

  )

}