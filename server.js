const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const DiscordStrategy = require('passport-discord').Strategy;
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const stripe = require('stripe');
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
require('dotenv').config();

// Import models
const User = require('./models/User');
const Purchase = require('./models/Purchase');
const ServerStatus = require('./models/ServerStatus');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Stripe
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Discord Bot (with error handling)
let discordBot = null;
let discordBotReady = false;

// Only initialize Discord bot if token is provided
if (process.env.DISCORD_BOT_TOKEN) {
    try {
        discordBot = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        discordBot.once('ready', () => {
            console.log('✅ Discord bot is ready!');
            discordBotReady = true;
        });

        discordBot.on('error', (error) => {
            console.error('❌ Discord bot error:', error);
        });

        // Login Discord bot (non-blocking)
        discordBot.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
            console.error('❌ Discord bot login failed:', err);
            discordBotReady = false;
        });
    } catch (error) {
        console.error('❌ Discord bot initialization failed:', error);
        discordBotReady = false;
    }
} else {
    console.log('⚠️ Discord bot token not provided, skipping Discord integration');
}

// Connect to MongoDB with timeout
const connectDB = async () => {
    try {
        if (!process.env.MONGODB_URI) {
            throw new Error('MONGODB_URI environment variable is required');
        }

        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 10000, // 10 second timeout
            socketTimeoutMS: 45000,
            maxPoolSize: 10,
            bufferCommands: false,
        });
        
        console.log('✅ Connected to MongoDB');
        return true;
    } catch (err) {
        console.error('❌ MongoDB connection error:', err);
        return false;
    }
};

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// CORS configuration
app.use(cors({
    origin: [
        process.env.FRONTEND_URL,
        process.env.RAILWAY_STATIC_URL,
        'http://localhost:3001',
        'http://127.0.0.1:3001'
    ].filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint (MUST be before session middleware)
app.get('/health', (req, res) => {
    const mongoState = mongoose.connection.readyState;
    const mongoStatus = mongoState === 1 ? 'connected' : 
                       mongoState === 2 ? 'connecting' : 
                       mongoState === 3 ? 'disconnecting' : 'disconnected';

    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
        mongodb: mongoStatus,
        discord: discordBotReady ? 'ready' : 'not ready',
        port: PORT
    });
});

// Basic route for testing
app.get('/', (req, res) => {
    res.json({ 
        message: 'DayZ Server Backend API',
        status: 'running',
        timestamp: new Date().toISOString()
    });
});

// Session configuration (only if MongoDB is connected)
const initializeSession = () => {
    if (mongoose.connection.readyState === 1 && process.env.SESSION_SECRET) {
        app.use(session({
            secret: process.env.SESSION_SECRET,
            resave: false,
            saveUninitialized: false,
            store: MongoStore.create({
                mongoUrl: process.env.MONGODB_URI,
                touchAfter: 24 * 3600
            }),
            cookie: {
                secure: process.env.NODE_ENV === 'production',
                httpOnly: true,
                maxAge: 1000 * 60 * 60 * 24 * 7
            }
        }));

        // Initialize Passport after session
        app.use(passport.initialize());
        app.use(passport.session());

        // Setup Passport strategies
        setupPassportStrategies();
        
        console.log('✅ Session and Passport initialized');
    }
};

// Passport configuration
const setupPassportStrategies = () => {
    if (!process.env.STEAM_API_KEY || !process.env.DISCORD_CLIENT_ID) {
        console.log('⚠️ Missing Steam or Discord credentials, skipping auth setup');
        return;
    }

    // Passport Steam Strategy
    passport.use(new SteamStrategy({
        returnURL: `${process.env.RAILWAY_STATIC_URL || process.env.BASE_URL}/auth/steam/return`,
        realm: process.env.RAILWAY_STATIC_URL || process.env.BASE_URL,
        apiKey: process.env.STEAM_API_KEY
    }, async (identifier, profile, done) => {
        try {
            const steamId = profile.id;
            let user = await User.findOne({ steamId });

            if (!user) {
                user = new User({
                    steamId: steamId,
                    steamName: profile.displayName,
                    steamAvatar: profile.photos[0]?.value || null,
                    steamProfileUrl: profile._json.profileurl
                });
                await user.save();
            } else {
                user.steamName = profile.displayName;
                user.steamAvatar = profile.photos[0]?.value || null;
                user.lastLogin = new Date();
                await user.save();
            }

            return done(null, user);
        } catch (error) {
            console.error('❌ Steam auth error:', error);
            return done(error, null);
        }
    }));

    // Passport Discord Strategy
    passport.use(new DiscordStrategy({
        clientID: process.env.DISCORD_CLIENT_ID,
        clientSecret: process.env.DISCORD_CLIENT_SECRET,
        callbackURL: `${process.env.RAILWAY_STATIC_URL || process.env.BASE_URL}/auth/discord/callback`,
        scope: ['identify', 'email', 'guilds.join']
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            const discordId = profile.id;
            let user = await User.findOne({ discordId });

            if (!user) {
                user = await User.findOne({ 
                    $and: [
                        { steamId: { $exists: true } },
                        { discordId: { $exists: false } }
                    ]
                }).sort({ createdAt: -1 });

                if (user) {
                    user.discordId = discordId;
                    user.discordName = `${profile.username}#${profile.discriminator}`;
                    user.discordAvatar = profile.avatar;
                    user.discordEmail = profile.email;
                    user.isFullyAuthenticated = true;
                    await user.save();
                } else {
                    user = new User({
                        discordId: discordId,
                        discordName: `${profile.username}#${profile.discriminator}`,
                        discordAvatar: profile.avatar,
                        discordEmail: profile.email
                    });
                    await user.save();
                }
            } else {
                user.discordName = `${profile.username}#${profile.discriminator}`;
                user.discordAvatar = profile.avatar;
                user.discordEmail = profile.email;
                user.lastLogin = new Date();
                
                if (user.steamId && user.discordId) {
                    user.isFullyAuthenticated = true;
                }
                
                await user.save();
            }

            return done(null, user);
        } catch (error) {
            console.error('❌ Discord auth error:', error);
            return done(error, null);
        }
    }));

    passport.serializeUser((user, done) => {
        done(null, user._id);
    });

    passport.deserializeUser(async (id, done) => {
        try {
            const user = await User.findById(id);
            done(null, user);
        } catch (error) {
            done(error, null);
        }
    });
};

// API Routes (basic versions that work without full auth)
app.get('/api/user', (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    res.json({
        id: req.user._id,
        steamId: req.user.steamId,
        steamName: req.user.steamName,
        isFullyAuthenticated: req.user.isFullyAuthenticated || false
    });
});

app.get('/api/servers', async (req, res) => {
    try {
        const servers = await ServerStatus.find({ isActive: true }) || [];
        res.json(servers);
    } catch (error) {
        console.error('❌ Error fetching servers:', error);
        res.json([]); // Return empty array instead of error
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('✅ HTTP server closed');
        mongoose.connection.close(() => {
            console.log('✅ MongoDB connection closed');
            process.exit(0);
        });
    });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', async (err) => {
    if (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
    
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Railway URL: ${process.env.RAILWAY_STATIC_URL || 'Not set'}`);
    console.log(`📊 Health check: /health`);
    
    // Connect to MongoDB after server starts
    const dbConnected = await connectDB();
    if (dbConnected) {
        initializeSession();
    } else {
        console.log('⚠️ Running without database connection');
    }
});

// Handle server errors
server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
});

module.exports = app;
