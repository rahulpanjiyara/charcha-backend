import {Router} from 'express';
import { deleteAccount, forgotPassword, loginUser, registerUser, resetPassword } from '../controllers/auth.controller.js';

const router = Router();

router.post('/register',registerUser);
router.post('/login',loginUser);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.delete('/account', deleteAccount);

export default router;
