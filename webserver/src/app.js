require('dotenv').config() // Load environment variables from .env file

const fs = require('fs')
const marked = require('marked')
const ejs = require('ejs')
const Koa = require('koa')
const Router = require('koa-router')
const koaStatic = require('koa-static')
const session = require('koa-session')
const passport = require('koa-passport')
const GitHubStrategy = require('passport-github2').Strategy
const db = require('./db')

const app = new Koa()
const router = new Router()
const path = require('path')

const resolvePath = (...components) => path.join(__dirname, '..', ...components)

const readFileSync = (...components) => {
  const filename = resolvePath(...components)
  return fs.readFileSync(filename, { encoding: 'utf8' })
}

// Serve static files
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
      await passport.authenticate('github')(ctx, next)
    } else {
      ctx.status = 403
      ctx.body = 'Forbidden'
    }
  }
}

app.use(db.middleware)

router.get('/client-config/:installKey', async (ctx) => {
  const installKey = ctx.params.installKey?.toUpperCase()
  const configuration = await db.getConfigurationByInstallKey(
    ctx.db,
    installKey
  )

  if (configuration) {
    ctx.type = 'text/plain'
    ctx.body = configuration
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

router.get('/install-key', isAuthenticated, async (ctx) => {
  const username = ctx.state.user.username
  const installKey = await db.getInstallKeyByUser(ctx.db, username)

  // Read the Markdown template file
  const template = readFileSync('templates', 'install-key.md')

  const expanded = ejs.render(template, {
    data: {
      username,
      installKey,
    },
  })

  // Convert Markdown to HTML with custom options
  const html = marked.parse(expanded, markdownOptions)

  // Send the HTML response
  ctx.type = 'html'
  ctx.body = html
})

// Protected endpoint, requires authentication
router.get('/api/user', isAuthenticated, (ctx) => {
  ctx.body = `Hello, ${ctx.state.user.username}!`
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

// Logout route
router.get('/logout', (ctx) => ctx.logout(() => ctx.redirect('/')))

app.use(router.routes())
app.use(router.allowedMethods())

// Start the server
const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(`Server running on port ${port}`)
})
