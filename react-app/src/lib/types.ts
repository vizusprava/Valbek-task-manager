export type Role = 'admin' | 'user'
export type TaskStatus = 'neudělano' | 'rozpracováno' | 'připraveno ke kontrole' | 'schváleno' | 'hotovo'
export type TaskPriority = 'low' | 'medium' | 'high'

export interface Profile {
  id: string
  username: string
  name: string
  role: Role
  initials: string | null
  color: string | null
  bg_light: string | null
  bg_dark: string | null
}

export interface Project {
  id: string
  name: string
  description: string | null
  status: string
  due_date: string | null
  file_path: string | null
  created_at: string
  created_by: string | null
}

export interface ProjectWithMembers extends Project {
  project_members: { user_id: string; profiles: Profile }[]
}

export interface Subproject {
  id: string
  project_id: string
  name: string
  sort_order: number
  created_at: string
  created_by: string | null
}

export interface SubprojectTemplate {
  id: string
  name: string
  sort_order: number
}

export interface Task {
  id: string
  project_id: string
  subproject_id: string | null
  title: string
  description: string | null
  assigned_to: string | null
  status: TaskStatus
  priority: TaskPriority
  due_date: string | null
  file_path: string | null
  model_id: string | null
  annotation_id: string | null
  sort_order: number
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface TaskWithRelations extends Task {
  assigned: Pick<Profile, 'id' | 'name' | 'initials' | 'color'> | null
  creator: Pick<Profile, 'id' | 'name'> | null
  updater: Pick<Profile, 'id' | 'name'> | null
  comments: { count: number }[]
  project?: Pick<Project, 'id' | 'name'>
  subproject?: Pick<Subproject, 'id' | 'name'> | null
  task_assignees?: { user_id: string; profiles: Pick<Profile, 'id' | 'name' | 'initials' | 'color'> | null }[]
  linked_model?: { id: string; name: string } | null
  annotation?: { id: string; text: string; object_name: string | null; x: number; y: number; z: number; model_id: string; model: { id: string; name: string } | null } | null
}

export interface TaskAttachment {
  id: string
  task_id: string
  name: string
  file_path: string
  mime_type: string | null
  file_size: number | null
  created_by: string | null
  created_at: string
}

export interface Comment {
  id: string
  task_id: string
  author_id: string
  text: string
  created_at: string
  author: Pick<Profile, 'id' | 'name'> | null
}

export interface Notification {
  id: string
  user_id: string
  type: string
  message: string
  task_id: string | null
  project_id: string | null
  is_read: boolean
  created_at: string
}

export interface TaskActivity {
  id: string
  task_id: string
  user_id: string
  field: string
  old_value: string | null
  new_value: string | null
  created_at: string
  user?: Pick<Profile, 'id' | 'name'>
}

export interface TaskAttachment {
  id: string
  task_id: string
  uploaded_by: string
  file_name: string
  file_path: string
  file_size: number | null
  mime_type: string | null
  created_at: string
  uploader?: Pick<Profile, 'id' | 'name'>
}

export interface TaskTemplate {
  id: string
  name: string
  title: string
  description: string | null
  priority: TaskPriority
  created_at: string
  created_by: string | null
}

export interface ModelFile {
  id: string
  name: string
  description: string | null
  file_path: string
  thumbnail_path: string | null
  file_size: number | null
  project_id: string | null
  camera_state: { px: number; py: number; pz: number; tx: number; ty: number; tz: number } | null
  created_at: string
  created_by: string | null
}

export interface ModelObjectColor {
  model_id: string
  object_name: string
  color: string
  updated_by: string | null
  updated_at: string
}

export interface ModelAnnotation {
  id: string
  model_id: string
  x: number
  y: number
  z: number
  text: string
  object_name: string | null
  created_by: string | null
  created_at: string
}

export interface ReferenceItem {
  id: string
  page: string
  section: string
  code: string | null
  name: string
  sort_order: number
}

export interface SpreadsheetColumn { id: string; name: string; width: number }
export interface SpreadsheetCell { value: string; bgColor?: string; textColor?: string }
export interface SpreadsheetRow { id: string; cells: Record<string, SpreadsheetCell> }
export interface SpreadsheetData { columns: SpreadsheetColumn[]; rows: SpreadsheetRow[] }
export interface Spreadsheet {
  id: string
  name: string
  data: SpreadsheetData
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

// Supabase Database type (pro typed client)
export type Database = {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: Omit<Profile, 'id' | 'bg_light' | 'bg_dark'>; Update: Partial<Profile> }
      projects: { Row: Project; Insert: Omit<Project, 'id' | 'created_at'>; Update: Partial<Project> }
      project_members: { Row: { project_id: string; user_id: string }; Insert: { project_id: string; user_id: string }; Update: never }
      subprojects: { Row: Subproject; Insert: Omit<Subproject, 'id' | 'created_at'>; Update: Partial<Subproject> }
      subproject_templates: { Row: SubprojectTemplate; Insert: Omit<SubprojectTemplate, 'id'>; Update: Partial<SubprojectTemplate> }
      tasks: { Row: Task; Insert: Omit<Task, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Task> }
      comments: { Row: Comment; Insert: Omit<Comment, 'id' | 'created_at'>; Update: Partial<Comment> }
      notifications: { Row: Notification; Insert: Omit<Notification, 'id' | 'created_at'>; Update: Partial<Notification> }
      task_activity: { Row: TaskActivity; Insert: Omit<TaskActivity, 'id' | 'created_at'>; Update: never }
      task_attachments: { Row: TaskAttachment; Insert: Omit<TaskAttachment, 'id' | 'created_at'>; Update: never }
      reference_items: { Row: ReferenceItem; Insert: Omit<ReferenceItem, 'id'>; Update: Partial<ReferenceItem> }
      task_templates: { Row: TaskTemplate; Insert: Omit<TaskTemplate, 'id' | 'created_at'>; Update: Partial<TaskTemplate> }
      task_assignees: { Row: { task_id: string; user_id: string }; Insert: { task_id: string; user_id: string }; Update: never }
      model_annotations: { Row: ModelAnnotation; Insert: Omit<ModelAnnotation, 'id' | 'created_at'>; Update: Partial<ModelAnnotation> }
    }
    Functions: {
      get_email_by_username: {
        Args: { p_username: string }
        Returns: string
      }
      is_admin: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      is_project_member: {
        Args: { proj_id: string }
        Returns: boolean
      }
    }
  }
}
