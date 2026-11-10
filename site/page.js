import { InstallError, install } from './install.js'

const form = document.querySelector('#install')
const button = form.querySelector('button')
const progress = document.querySelector('#progress')
const problem = document.querySelector('#problem')
const done = document.querySelector('#done')

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  button.disabled = true
  progress.replaceChildren()
  progress.hidden = false
  problem.hidden = true
  done.hidden = true
  const value = (id) => document.querySelector(id).value.trim()
  try {
    const address = await install({
      token: value('#token'),
      accountId: value('#account'),
      name: value('#name'),
      log(text) {
        const item = document.createElement('li')
        item.textContent = text
        progress.append(item)
      },
    })
    const link = done.querySelector('a')
    link.href = address
    link.textContent = address
    done.hidden = false
    document.querySelector('#token').value = ''
  } catch (error) {
    problem.textContent =
      error instanceof InstallError ? error.message : 'Something went wrong. Try again.'
    problem.hidden = false
  } finally {
    button.disabled = false
  }
})
