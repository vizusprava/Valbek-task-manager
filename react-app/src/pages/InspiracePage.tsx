import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Heart, MessageCircle, Plus, X, Send, Globe, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageLayout } from '@/components/layout/PageLayout'
import { Avatar } from '@/components/ui/Avatar'

interface Profile { id: string; name: string; initials: string; color: string }

interface Post {
  id: string
  url: string
  title: string | null
  description: string | null
  created_by: string | null
  created_at: string
  profiles: Profile | null
}

interface Like { post_id: string; user_id: string }

interface Comment {
  id: string
  post_id: string
  content: string
  created_by: string | null
  created_at: string
  profiles: Profile | null
}

function getDomain(url: string) {
  try { return new URL(url).hostname.replace('www.', '') } catch { return url }
}

function formatRelative(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'před chvílí'
  if (m < 60) return `před ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `před ${h} h`
  const d = Math.floor(h / 24)
  if (d < 7) return `před ${d} d`
  return new Date(dateStr).toLocaleDateString('cs-CZ')
}

function NewPostModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuthStore()
  const qc = useQueryClient()
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) { setUrl(''); setTitle(''); setDescription('') }
  }, [open])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim() || !user) return
    setSaving(true)
    const { error } = await supabase.from('inspiration_posts').insert({
      url: url.trim(),
      title: title.trim() || null,
      description: description.trim() || null,
      created_by: user.id,
    })
    setSaving(false)
    if (error) { toast.error('Nepodařilo se sdílet odkaz'); return }
    toast.success('Odkaz sdílen!')
    qc.invalidateQueries({ queryKey: ['inspiration-posts'] })
    onClose()
  }

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Sdílet odkaz</h2>
          <button onClick={onClose} className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">URL *</label>
            <input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://..."
              required
              autoFocus
              className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Název (volitelný)</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Název článku / webu…"
              className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Komentář / popis (volitelný)</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Proč to sdílíš? Co je zajímavého?"
              rows={3}
              className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800">
              Zrušit
            </button>
            <button type="submit" disabled={saving || !url.trim()}
              className="flex-1 px-3 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 font-medium">
              {saving ? 'Sdílím…' : 'Sdílet'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function PostCard({ post, likes, commentCount, onLike, userId }: {
  post: Post
  likes: Like[]
  commentCount: number
  onLike: (postId: string) => void
  userId: string
}) {
  const [showComments, setShowComments] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [addingComment, setAddingComment] = useState(false)
  const qc = useQueryClient()

  const domain = getDomain(post.url)
  const likeCount = likes.filter(l => l.post_id === post.id).length
  const userLiked = likes.some(l => l.post_id === post.id && l.user_id === userId)

  const { data: comments = [] } = useQuery({
    queryKey: ['inspiration-comments', post.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('inspiration_comments')
        .select('*, profiles(id, name, initials, color)')
        .eq('post_id', post.id)
        .order('created_at', { ascending: true })
      return (data ?? []) as Comment[]
    },
    enabled: showComments,
  })

  async function handleAddComment(e: React.FormEvent) {
    e.preventDefault()
    if (!commentText.trim()) return
    setAddingComment(true)
    const { error } = await supabase.from('inspiration_comments').insert({
      post_id: post.id,
      content: commentText.trim(),
      created_by: userId,
    })
    setAddingComment(false)
    if (error) { toast.error('Nepodařilo se přidat komentář'); return }
    setCommentText('')
    qc.invalidateQueries({ queryKey: ['inspiration-comments', post.id] })
    qc.invalidateQueries({ queryKey: ['inspiration-comment-counts'] })
  }

  async function handleDeletePost() {
    if (!confirm('Smazat příspěvek?')) return
    await supabase.from('inspiration_posts').delete().eq('id', post.id)
    qc.invalidateQueries({ queryKey: ['inspiration-posts'] })
    qc.invalidateQueries({ queryKey: ['inspiration-comment-counts'] })
    toast.success('Příspěvek smazán')
  }

  const totalComments = showComments ? comments.length : commentCount

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          {post.profiles && (
            <Avatar name={post.profiles.name} initials={post.profiles.initials} color={post.profiles.color} small />
          )}
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{post.profiles?.name ?? 'Neznámý'}</p>
            <p className="text-xs text-gray-400">{formatRelative(post.created_at)}</p>
          </div>
        </div>
        {post.created_by === userId && (
          <button onClick={handleDeletePost}
            className="p-1 text-gray-300 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 transition-colors rounded">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* URL card */}
      <a href={post.url} target="_blank" rel="noopener noreferrer"
        className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors group">
        <img
          src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
          alt=""
          className="w-5 h-5 rounded shrink-0"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
        <div className="flex-1 min-w-0">
          {post.title && (
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{post.title}</p>
          )}
          <p className={`text-xs text-gray-400 truncate flex items-center gap-1 ${post.title ? '' : 'text-sm'}`}>
            <Globe size={10} className="shrink-0" />
            {domain}
          </p>
        </div>
        <ExternalLink size={14} className="text-gray-300 dark:text-gray-600 group-hover:text-indigo-500 transition-colors shrink-0" />
      </a>

      {/* Description */}
      {post.description && (
        <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">{post.description}</p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-4 pt-0.5">
        <button
          onClick={() => onLike(post.id)}
          className={`flex items-center gap-1.5 text-sm transition-colors ${userLiked ? 'text-red-500 dark:text-red-400' : 'text-gray-400 hover:text-red-500 dark:hover:text-red-400'}`}
        >
          <Heart size={15} className={userLiked ? 'fill-current' : ''} />
          {likeCount > 0 && <span className="text-xs">{likeCount}</span>}
        </button>
        <button
          onClick={() => setShowComments(o => !o)}
          className={`flex items-center gap-1.5 text-sm transition-colors ${showComments ? 'text-indigo-500 dark:text-indigo-400' : 'text-gray-400 hover:text-indigo-500 dark:hover:text-indigo-400'}`}
        >
          <MessageCircle size={15} />
          {totalComments > 0 && <span className="text-xs">{totalComments}</span>}
        </button>
      </div>

      {/* Comments */}
      {showComments && (
        <div className="pt-2 space-y-2 border-t border-gray-100 dark:border-gray-800">
          {comments.map(c => (
            <div key={c.id} className="flex items-start gap-2">
              {c.profiles && (
                <Avatar name={c.profiles.name} initials={c.profiles.initials} color={c.profiles.color} small />
              )}
              <div className="flex-1 bg-gray-50 dark:bg-gray-800/50 rounded-lg px-3 py-2">
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-0.5">{c.profiles?.name ?? 'Neznámý'}</p>
                <p className="text-sm text-gray-600 dark:text-gray-300">{c.content}</p>
              </div>
            </div>
          ))}
          <form onSubmit={handleAddComment} className="flex items-center gap-2 pt-1">
            <input
              type="text"
              value={commentText}
              onChange={e => setCommentText(e.target.value)}
              placeholder="Přidat komentář…"
              className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button type="submit" disabled={addingComment || !commentText.trim()}
              className="p-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
              <Send size={13} />
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

export function InspiracePage() {
  const { user } = useAuthStore()
  const qc = useQueryClient()
  const [newPostOpen, setNewPostOpen] = useState(false)

  const { data: posts = [], isLoading } = useQuery({
    queryKey: ['inspiration-posts'],
    queryFn: async () => {
      const { data } = await supabase
        .from('inspiration_posts')
        .select('*, profiles(id, name, initials, color)')
        .order('created_at', { ascending: false })
      return (data ?? []) as Post[]
    },
  })

  const { data: likes = [] } = useQuery({
    queryKey: ['inspiration-likes'],
    queryFn: async () => {
      const { data } = await supabase.from('inspiration_likes').select('post_id, user_id')
      return (data ?? []) as Like[]
    },
  })

  const { data: commentCounts = [] } = useQuery({
    queryKey: ['inspiration-comment-counts'],
    queryFn: async () => {
      const { data } = await supabase.from('inspiration_comments').select('id, post_id')
      return (data ?? []) as { id: string; post_id: string }[]
    },
  })

  async function handleLike(postId: string) {
    if (!user) return
    const alreadyLiked = likes.some(l => l.post_id === postId && l.user_id === user.id)
    if (alreadyLiked) {
      await supabase.from('inspiration_likes').delete().eq('post_id', postId).eq('user_id', user.id)
    } else {
      await supabase.from('inspiration_likes').insert({ post_id: postId, user_id: user.id })
    }
    qc.invalidateQueries({ queryKey: ['inspiration-likes'] })
  }

  return (
    <PageLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Inspirace</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Zajímavé odkazy a tipy z oboru</p>
          </div>
          <button onClick={() => setNewPostOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors">
            <Plus size={16} />
            Sdílet odkaz
          </button>
        </div>

        {isLoading && (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!isLoading && posts.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <Globe size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">Zatím žádné příspěvky. Buď první!</p>
          </div>
        )}

        <div className="space-y-4">
          {posts.map(post => (
            <PostCard
              key={post.id}
              post={post}
              likes={likes}
              commentCount={commentCounts.filter(c => c.post_id === post.id).length}
              onLike={handleLike}
              userId={user?.id ?? ''}
            />
          ))}
        </div>
      </div>

      <NewPostModal open={newPostOpen} onClose={() => setNewPostOpen(false)} />
    </PageLayout>
  )
}
