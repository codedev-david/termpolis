import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

import {
  sendMessage,
  readMessages,
  getAllMessages,
  createTask,
  listTasks,
  updateTask,
  clearSwarm,
} from '../../src/main/swarmManager'

beforeEach(() => {
  clearSwarm()
})

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
describe('sendMessage', () => {
  it('creates a message with correct fields', () => {
    const msg = sendMessage('term-1', 'term-2', 'info', 'hello')
    expect(msg).toMatchObject({
      from: 'term-1',
      to: 'term-2',
      type: 'info',
      content: 'hello',
      read: false,
    })
    expect(msg.id).toBeDefined()
    expect(typeof msg.timestamp).toBe('number')
  })

  it('returns the created message', () => {
    const msg = sendMessage('a', 'b', 'task', 'do stuff')
    const all = getAllMessages()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(msg.id)
  })
})

describe('readMessages', () => {
  it('returns unread messages for the target terminal', () => {
    sendMessage('term-1', 'term-2', 'info', 'hi')
    const msgs = readMessages('term-2')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('hi')
  })

  it('returns broadcast messages (to: "all")', () => {
    sendMessage('term-1', 'all', 'info', 'broadcast')
    const msgs = readMessages('term-99')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('broadcast')
  })

  it('marks messages as read so second call returns empty', () => {
    sendMessage('term-1', 'term-2', 'info', 'once')
    expect(readMessages('term-2')).toHaveLength(1)
    expect(readMessages('term-2')).toHaveLength(0)
  })

  it('does not return messages addressed to other terminals', () => {
    sendMessage('term-1', 'term-3', 'info', 'not for you')
    const msgs = readMessages('term-2')
    expect(msgs).toHaveLength(0)
  })
})

describe('message cap', () => {
  it('caps messages at 500 — oldest removed when exceeded', () => {
    for (let i = 0; i < 505; i++) {
      sendMessage('a', 'b', 'info', `msg-${i}`)
    }
    const all = getAllMessages()
    expect(all).toHaveLength(500)
    // The first 5 messages (msg-0 through msg-4) should have been evicted
    expect(all[0].content).toBe('msg-5')
    expect(all[all.length - 1].content).toBe('msg-504')
  })
})

describe('getAllMessages', () => {
  it('returns copies, not references to the internal array', () => {
    sendMessage('a', 'b', 'info', 'original')
    const copy1 = getAllMessages()
    const copy2 = getAllMessages()
    // They are different array instances
    expect(copy1).not.toBe(copy2)
    // Mutating the returned array does not affect internal state
    copy1.push({} as any)
    expect(getAllMessages()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
describe('createTask', () => {
  it('creates with pending status when no assignTo', () => {
    const task = createTask('Fix bug', 'Fix the login bug', 'term-1')
    expect(task.status).toBe('pending')
    expect(task.assignedTo).toBe('')
    expect(task.title).toBe('Fix bug')
    expect(task.description).toBe('Fix the login bug')
    expect(task.createdBy).toBe('term-1')
    expect(typeof task.createdAt).toBe('number')
    expect(task.completedAt).toBeUndefined()
  })

  it('creates with in_progress status when assignTo provided', () => {
    const task = createTask('Review PR', 'Review the PR', 'term-1', 'term-2')
    expect(task.status).toBe('in_progress')
    expect(task.assignedTo).toBe('term-2')
  })
})

describe('listTasks', () => {
  it('returns all tasks', () => {
    createTask('Task 1', 'desc', 'a')
    createTask('Task 2', 'desc', 'b')
    createTask('Task 3', 'desc', 'c')
    expect(listTasks()).toHaveLength(3)
  })
})

describe('updateTask', () => {
  it('changes status and sets result', () => {
    const task = createTask('Do it', 'desc', 'term-1', 'term-2')
    const updated = updateTask(task.id, 'completed', 'done!')
    expect(updated).not.toBeNull()
    expect(updated!.status).toBe('completed')
    expect(updated!.result).toBe('done!')
  })

  it('sets completedAt for completed status', () => {
    const task = createTask('T', 'd', 'a', 'b')
    const updated = updateTask(task.id, 'completed')
    expect(updated!.completedAt).toBeDefined()
    expect(typeof updated!.completedAt).toBe('number')
  })

  it('sets completedAt for failed status', () => {
    const task = createTask('T', 'd', 'a', 'b')
    const updated = updateTask(task.id, 'failed', 'oops')
    expect(updated!.completedAt).toBeDefined()
    expect(updated!.result).toBe('oops')
  })

  it('does not set completedAt for in_progress status', () => {
    const task = createTask('T', 'd', 'a')
    const updated = updateTask(task.id, 'in_progress')
    expect(updated!.completedAt).toBeUndefined()
  })

  it('returns null for non-existent taskId', () => {
    expect(updateTask('nonexistent-id', 'completed')).toBeNull()
  })
})

describe('task cap', () => {
  it('caps tasks at 200 — oldest removed when exceeded', () => {
    for (let i = 0; i < 205; i++) {
      createTask(`Task ${i}`, 'desc', 'a')
    }
    const all = listTasks()
    expect(all).toHaveLength(200)
    expect(all[0].title).toBe('Task 5')
    expect(all[all.length - 1].title).toBe('Task 204')
  })
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
describe('clearSwarm', () => {
  it('empties both messages and tasks', () => {
    sendMessage('a', 'b', 'info', 'hi')
    sendMessage('a', 'b', 'info', 'hi2')
    createTask('T', 'd', 'a')
    clearSwarm()
    expect(getAllMessages()).toHaveLength(0)
    expect(listTasks()).toHaveLength(0)
  })
})
