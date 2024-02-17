require('dotenv').config() // Load environment variables from .env file

const fs = require('fs')
const marked = require('marked')
const ejs = require('ejs')
const Koa = require('koa')
const Router = require('koa-router')
const bodyParser = require('koa-bodyparser')
const koaStatic = require('koa-static')
const session = require('koa-session')
const websockify = require('koa-websocket')
const pty = require('node-pty')
const passport = require('koa-passport')
const GitHubStrategy = require('passport-github2').Strategy
const db = require('./db')
const bridgeInfo = require('./bridgeInfo')

const app = websockify(new Koa())
const router = new Router()
const path = require('path')
const Ajv = require('ajv')
const ethernetToDecnet = require('./ethernetToDecnet')

const resolvePath = (...components) => path.join(__dirname, '..', ...components)

const readFileSync = (...components) =>
  fs.readFileSync(resolvePath(...components), { encoding: 'utf8' })

app.use(bodyParser())
app.use(koaStatic(resolvePath('public')))

// Session middleware
app.keys = [process.env.SESSION_SECRET]
app.use(session({}, app))

// Initialize passport middleware
app.use(passport.initialize())
app.use(passport.session())

// GitHub OAuth2 configuration
passport.use(
  new GitHubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: 'http://localhost:3000/auth/github/callback',
    },
    (accessToken, refreshToken, profile, done) => {
      // Here you can save user profile data to a database
      return done(null, profile)
    }
  )
)

const LocalStrategy = require('passport-local').Strategy

// Define the Local strategy for username/password authentication
passport.use(
  new LocalStrategy(async (username, password, done) => {
    try {
      // Call the checkUser function to verify the username/password
      const user = await db.checkPassword(username, password)

      if (user) {
        // If the user is found and the password is correct, return the user
        done(null, user)
      } else {
        // If the user is not found or the password is incorrect, return false
        done(null, false)
      }
    } catch (error) {
      done(error)
    }
  })
)

// Serialize user into session
passport.serializeUser((user, done) => {
  done(null, user)
})

// Deserialize user from session
passport.deserializeUser((user, done) => {
  done(null, user)
})

const isAuthenticated = async (ctx, next) => {
  if (ctx.isAuthenticated()) {
    await next()
  } else {
    if (ctx.accepts('html')) {
      ctx.redirect('/login?path=' + ctx.path)
      // await passport.authenticate('github')(ctx, next)
    } else {
      ctx.status = 403
      ctx.body = 'Forbidden'
    }
  }
}

app.use(db.middleware)

const renderTemplate = (content, state, data) =>
  ejs.render(content, { ...state, ...(data || {}) })
const renderTemplateFile = (filename, state, data) =>
  renderTemplate(readFileSync('templates', filename), state, data)

router.get('/client-config/:installKey', async (ctx) => {
  const installKey = ctx.params.installKey?.toUpperCase()
  const configuration = await db.getConfigurationByInstallKey(
    ctx.db,
    installKey
  )

  if (configuration) {
    ctx.type = 'text/plain'
    ctx.body = renderTemplateFile('client-config.ejs', ctx.state, {
      ...configuration,
      ca_certificate: readFileSync('../ca/data', 'ca.crt'),
      ta_key: readFileSync('../ca/data', 'ta.key'),
    })
  } else {
    ctx.status = 404
    ctx.body = 'Configuration not found'
  }
})

const markdownOptions = {
  renderer: new marked.Renderer(),
  gfm: true,
  breaks: false,
}

router.get('/installation', isAuthenticated, async (ctx, next) => {
  const username = ctx.state.user.username

  ctx.state.installKey = await db.getInstallKeyByUser(ctx.db, username)

  await next()
})

router.get('/status', async (ctx, next) => {
  ctx.state.protocols = await db.getProtocols()
  ctx.state.hosts = (await db.getActiveHosts()).map((host) => ({
    ...host,
    decnet: ethernetToDecnet(host.mac_address),
  }))

  await next()
})

router.get('/set-password', async (ctx, next) => {
  const key = ctx.request.query.key
  if (key) {
    ctx.state.keyValid = await db.checkPasswordResetKey(key)
    ctx.state.key = key
  } else {
    ctx.state.keyValid = false
    ctx.state.key = ''
  }
  next()
})

router.get('/:page', (ctx, next) => {
  let content = null
  if (fs.existsSync(resolvePath('templates', `${ctx.params.page}.md`))) {
    content = marked.parse(
      renderTemplateFile(`${ctx.params.page}.md`, ctx.state),
      markdownOptions
    )
  } else if (
    fs.existsSync(resolvePath('templates', `${ctx.params.page}.html`))
  ) {
    content = renderTemplate(
      readFileSync('templates', `${ctx.params.page}.html`),
      ctx.state
    )
  }

  if (content) {
    // Send the HTML response
    ctx.type = 'text/html'
    ctx.body = renderTemplateFile('layout.ejs', ctx.state, {
      content,
      page_name: ctx.params.page,
    })
  } else {
    next()
  }
})

router.redirect('/', '/news')

router.get('/install.sh', (ctx) => {
  ctx.type = 'text/plain'
  ctx.body = renderTemplateFile('install.sh.ejs', ctx.state)
})

// host maintenance

router.get('/api/hosts', async (ctx) => {
  ctx.body = await db.getActiveHosts()
})

const validateHostUpdateSchema = new Ajv().compile({
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
  },
  additionalProperties: false,
})

router.put('/api/host/:mac_address', isAuthenticated, async (ctx) => {
  const valid = validateHostUpdateSchema(ctx.request.body)

  if (!valid) {
    ctx.status = 400
    ctx.body = validate.errors
    return
  }

  await db.updateHost(
    ctx.state.user.username,
    ctx.params.mac_address,
    ctx.request.body.name,
    ctx.request.body.description
  )

  ctx.status = 204
})

// GitHub authentication route
router.get(
  '/auth/github',
  passport.authenticate('github', { scope: ['user:email'] })
)

// GitHub authentication callback route
router.get(
  '/auth/github/callback',
  passport.authenticate('github', {
    successRedirect: '/',
    failureRedirect: '/',
  })
)

router.post('/auth/login', async (ctx, next) => {
  // Check if the request body contains username and password
  const { username, password } = ctx.request.body

  if (username && password) {
    // Attempt Local authentication
    await passport.authenticate('local', async (err, user, info) => {
      if (err) {
        ctx.status = 500
        ctx.body = 'Internal Server Error'
      } else if (!user) {
        if (ctx.accepts('html')) {
          ctx.redirect('/login?error=1&path=' + (ctx.request.query.path || '/'))
          // await passport.authenticate('github')(ctx, next)
        } else {
          ctx.status = 403
        }
      } else {
        // If Local authentication succeeds, log in the user
        await ctx.login(user)
        ctx.redirect(ctx.request.query.path || '/')
      }
    })(ctx, next)
  } else {
    // If username or password is missing, attempt GitHub authentication
    await passport.authenticate('github')(ctx, next)
  }
})

router.post('/auth/set-password', async (ctx, next) => {
  if (ctx.request.body.key) {
    await db.resetPassword(ctx.request.body.key, ctx.request.body.password)
  } else if (ctx.state.user) {
    await db.setPassword(ctx.state.user.username, ctx.request.body.password)
  } else {
    ctx.status = 400
    return
  }
  ctx.redirect('/login?reset-success=1')
})

// Logout route
router.get('/logout', (ctx) => ctx.logout(() => ctx.redirect('/')))

// WebSocket route
app.ws.use((ctx, next) => {
  // Create a new PTY process
  const ptyProcess = pty.spawn(shell, [], {
    name: 'vt100',
    env: process.env,
    cwd: process.env.HOME,
    cols: 80,
    rows: 24,
  })
  console.log('new websocket session')

  // When UI sends message, resize or run command
  ctx.websocket.on('message', (message) => {
    const processedMessage = messageProcessor(message)
    if (processedMessage.type === 'command') {
      ptyProcess.write(processedMessage.command)
    } else if (processedMessage.type === 'resize') {
      ptyProcess.resize(processedMessage.cols, processedMessage.rows)
    }
  })

  // When PTY returns data, send to UI
  ptyProcess.on('data', function (rawOutput) {
    const processedOutput = outputProcessor(rawOutput)
    ctx.websocket.send(processedOutput)
  })

  return next()
})

app.use(router.routes())
app.use(router.allowedMethods())

bridgeInfo.startHostUpdater()

const port = process.env.PORT || 3000
app.listen(port, () => console.log(`Server running on port ${port}`))
